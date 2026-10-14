/**
 * MCP server domain (Phase 7) — read-only, permission-scoped tools over the
 * Model Context Protocol, authenticated by an API key.
 */
export {
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  assertNoForbiddenTools,
  findTool,
  isForbiddenToolName,
  type McpToolDef,
} from './tools';

export {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  handleMcpMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './server';

export {
  AI_FEATURES_FLAG,
  AiFeatureChangeError,
  MCP_PII_SCOPE,
  MCP_READ_SCOPE,
  MCP_WITHHELD_FIELDS,
  allowsMcpPii,
  assertAiFeatureChange,
  hasMcpScope,
  mcpAuditAfter,
  mcpHttpStatus,
  mcpRateAllows,
  mcpRateWindow,
  minimiseMcpValue,
} from './policy';

export {
  getTenantAiFeatures,
  setTenantAiFeatures,
  tenantAiOptedIn,
  type TenantAiFeaturesStatus,
} from './opt-in';

export { consumeMcpRateLimit, McpRateLimitError } from './rate-limit';
