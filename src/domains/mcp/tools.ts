import type { Permission } from '@/lib/permissions/catalog';

/**
 * MCP tool registry — pure metadata.
 *
 * Every tool is READ-ONLY and permission-scoped. Authorisation is enforced by
 * the underlying domain services (the tool runs inside the API key's scoped
 * tenant context), so the key's permissions decide what a tool can see.
 *
 * PRODUCT INVARIANT: there is NO tool that scores, ranks, predicts, approves,
 * rejects, determines or finalises anything about a person's Aboriginality —
 * and `assertNoForbiddenTools` guarantees none can be added by accident. Every
 * tool merely reads existing records that authorised humans created.
 */

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
  /** Permission keys, ANY of which the calling key must hold. */
  readonly scopes: readonly Permission[];
}

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'list_applications',
    description:
      'List applications in the organisation the key may read. Optional status filter and paging.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by application status.' },
        limit: { type: 'number', description: 'Max rows (1-100).' },
        offset: { type: 'number', description: 'Rows to skip.' },
      },
    },
    scopes: ['application:read-any', 'application:read-assigned'],
  },
  {
    name: 'get_application',
    description: 'Fetch a single application by id (subject to the read policy).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Application id.' } },
      required: ['id'],
    },
    scopes: ['application:read-any', 'application:read-assigned', 'application:read-own'],
  },
  {
    name: 'list_family_links',
    description:
      'List family connections recorded on an application. This is a human record, not a determination. When relativeDeceased is true, show a warning before displaying the relative name.',
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string' } },
      required: ['applicationId'],
    },
    scopes: ['application:read-any', 'application:read-assigned', 'application:read-own'],
  },
  {
    name: 'list_decisions',
    description: 'List committee decisions recorded on an application.',
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string' } },
      required: ['applicationId'],
    },
    scopes: ['application:read-any', 'application:read-assigned'],
  },
  {
    name: 'list_meetings',
    description: 'List the committee meetings in the organisation.',
    inputSchema: { type: 'object', properties: {} },
    scopes: ['meeting:pack-access', 'meeting:create', 'meeting:agenda-manage'],
  },
  {
    name: 'organisation_stats',
    description: 'Return pipeline counts and what needs attention for the organisation.',
    inputSchema: { type: 'object', properties: {} },
    scopes: ['report:view', 'application:read-any'],
  },
] as const;

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);

/** Patterns that would indicate a determinative/mutating tool. Forbidden. */
const FORBIDDEN =
  /score|rank|predict|approve|reject|determine|finalise|decide|create|update|delete|sign|revoke|vote|classif/i;

export function isForbiddenToolName(name: string): boolean {
  return FORBIDDEN.test(name);
}

/** Throws if any registered tool looks determinative/mutating. */
export function assertNoForbiddenTools(): void {
  for (const tool of MCP_TOOLS) {
    if (isForbiddenToolName(tool.name)) {
      throw new Error(`Forbidden MCP tool registered: ${tool.name}`);
    }
  }
}

export function findTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
