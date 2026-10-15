import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { redis, tenantKey } from '@/lib/redis';
import { mcpRateAllows, mcpRateWindow } from './policy';

/**
 * Per-key fixed window for the external tool endpoint.
 * Redis failing closed: a disclosure path does not proceed when the counter
 * cannot be recorded.
 */

const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export class McpRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Too many requests');
    this.name = 'McpRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function consumeMcpRateLimit(
  organisationId: string,
  keyId: string,
  nowMs = Date.now(),
): Promise<void> {
  const { bucket, retryAfterSeconds } = mcpRateWindow(nowMs);
  const redisKey = tenantKey(organisationId, 'mcp-rl', keyId, bucket);
  try {
    const count = Number(await redis.eval(INCR_WITH_TTL, 1, redisKey, '120'));
    if (!Number.isFinite(count) || !mcpRateAllows(count, env.MCP_RATE_LIMIT_PER_MINUTE)) {
      throw new McpRateLimitError(retryAfterSeconds);
    }
  } catch (error) {
    if (error instanceof McpRateLimitError) throw error;
    logger.error({ err: error }, 'mcp rate limit unavailable');
    throw new McpRateLimitError(retryAfterSeconds);
  }
}
