import { NextResponse } from 'next/server';
import { apiErrorResponse, withApiKey } from '@/lib/http/api-route';
import { recordAudit } from '@/domains/audit/service';
import { env } from '@/lib/env';
import { REQUEST_LIMITS } from '@/lib/http/request-limits';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  consumeMcpRateLimit,
  handleMcpMessage,
  hasMcpScope,
  mcpAuditAfter,
  mcpHttpStatus,
  McpRateLimitError,
  tenantAiOptedIn,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@/domains/mcp';

/**
 * POST /api/mcp — Model Context Protocol endpoint (JSON-RPC 2.0 over HTTP).
 *
 * Closed unless the platform flag is on. A tenant that has not recorded
 * governance approval and turned `aiFeatures` on is refused. The key must hold
 * an `mcp:` scope. Tool calls run inside that key's scoped tenant context and
 * are read-only (see src/domains/mcp/tools.ts) — nothing here scores, mutates
 * or determines anything.
 */
export const dynamic = 'force-dynamic';

function notFound(): Response {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export function GET(): Response {
  return notFound();
}

export async function POST(request: Request): Promise<Response> {
  // Global flag is the only check that hides the route. Tenant opt-in and
  // scope are decided after the key is authenticated, so pass them as satisfied
  // here — a false value would refuse before we know the tenant.
  if (
    mcpHttpStatus({
      globalEnabled: env.AI_FEATURES_ENABLED,
      tenantOptedIn: true,
      hasMcpScope: true,
    }) === 404
  ) {
    return notFound();
  }

  try {
    const body = (await request.json().catch(() => undefined)) as
      | JsonRpcRequest
      | undefined;

    const response = await withApiKey(
      request,
      async (ctx): Promise<JsonRpcResponse | null> => {
        const status = mcpHttpStatus({
          globalEnabled: true,
          tenantOptedIn: await tenantAiOptedIn(),
          hasMcpScope: hasMcpScope(ctx.permissions),
        });
        if (status === 403) {
          const keyId = ctx.userId;
          await recordAudit({
            action: 'search.performed',
            resourceType: 'api_key',
            resourceId: keyId,
            result: 'denied',
            reason: 'mcp.scope_denied',
            after: mcpAuditAfter({ keyId, tool: 'endpoint', piiDisclosed: false }),
          });
          throw new AuthorizationError('POLICY_DENIED');
        }

        await consumeMcpRateLimit(ctx.organisationId, ctx.userId);

        if (!body || typeof body.method !== 'string') {
          return {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          };
        }
        return handleMcpMessage(body);
      },
      REQUEST_LIMITS.mcp,
    );

    // A notification (no id) yields no response body.
    if (response === null) return new Response(null, { status: 202 });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof McpRateLimitError) {
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
      );
    }
    return apiErrorResponse(error);
  }
}
