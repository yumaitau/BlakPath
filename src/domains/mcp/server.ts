import { recordAudit } from '@/domains/audit/service';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  getApplication,
  listApplications,
  type ListApplicationsInput,
} from '@/domains/applications';
import { listDecisions } from '@/domains/decisions';
import { listMeetings } from '@/domains/meetings';
import { getOrganisationStats } from '@/domains/dashboard';
import { findTool, MCP_TOOLS } from './tools';

/**
 * MCP server core — a minimal, dependency-light JSON-RPC 2.0 handler for the
 * Model Context Protocol. Runs INSIDE an API key's scoped tenant context (the
 * route establishes it), so every tool is tenant-scoped and permission-checked
 * by the domain services it calls. Read-only by construction (see tools.ts).
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_INFO = { name: 'BlakPath', version: '0.1.0' } as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Run a single tool and return an MCP tool-result content block. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  const tool = findTool(name);
  const text = (value: unknown, isError = false) => ({
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    isError,
  });

  if (!tool) return text(`Unknown tool: ${name}`, true);

  // Attribute the read to the calling API key on the audit trail.
  await recordAudit({
    action: 'search.performed',
    resourceType: 'search',
    resourceId: name,
    result: 'success',
    reason: 'mcp.tool',
  });

  try {
    switch (name) {
      case 'list_applications': {
        const result = await listApplications(args as ListApplicationsInput);
        return text({
          items: result.items.map((a) => ({
            id: a.id,
            reference: a.reference,
            status: a.status,
            priority: a.priority,
          })),
          limit: result.limit,
          offset: result.offset,
        });
      }
      case 'get_application': {
        const id = asString(args.id);
        if (!id) return text('Missing required argument: id', true);
        const { application } = await getApplication(id);
        return text({
          id: application.id,
          reference: application.reference,
          applicantName: application.applicantName,
          status: application.status,
          priority: application.priority,
        });
      }
      case 'list_decisions': {
        const applicationId = asString(args.applicationId);
        if (!applicationId) return text('Missing required argument: applicationId', true);
        const decisions = await listDecisions(applicationId);
        return text(
          decisions.map((d) => ({
            id: d.id,
            proposedOutcome: d.proposedOutcome,
            finalOutcome: d.finalOutcome,
            status: d.status,
          })),
        );
      }
      case 'list_meetings': {
        const meetings = await listMeetings();
        return text(
          meetings.map((m) => ({
            id: m.id,
            title: m.title,
            scheduledStart: m.scheduledStart,
            status: m.status,
          })),
        );
      }
      case 'organisation_stats': {
        return text(await getOrganisationStats());
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return text('Forbidden: the API key lacks the required scope for this tool.', true);
    }
    return text('The tool call failed.', true);
  }
}

/**
 * Handle one JSON-RPC message. Returns a response, or null for notifications
 * (which must not be answered). Called once per message by the route.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = asString(params.name);
      if (!name) return err(id, -32602, 'Invalid params: tool name is required');
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      return ok(id, await callTool(name, args));
    }
    default:
      // Notifications (no id) are acknowledged silently.
      if (message.id === undefined) return null;
      return err(id, -32601, `Method not found: ${message.method}`);
  }
}
