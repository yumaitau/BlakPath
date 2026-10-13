import { NextResponse } from 'next/server';
import { apiErrorResponse, withApiKey } from '@/lib/http/api-route';
import { REQUEST_LIMITS } from '@/lib/http/request-limits';
import {
  handleMcpMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@/domains/mcp';

/**
 * POST /api/mcp — Model Context Protocol endpoint (JSON-RPC 2.0 over HTTP).
 *
 * Authenticated by an API key (`Authorization: Bearer bp_...`); every tool call
 * runs inside that key's SCOPED tenant context, so the key's permissions decide
 * what it can read. All tools are read-only (see src/domains/mcp/tools.ts) —
 * nothing here scores, mutates or determines anything.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => undefined)) as
      | JsonRpcRequest
      | undefined;

    const response = await withApiKey(
      request,
      async (): Promise<JsonRpcResponse | null> => {
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
    return apiErrorResponse(error);
  }
}
