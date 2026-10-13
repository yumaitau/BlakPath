/**
 * Agreed production signals. CloudFormation alarms in
 * `infra/aws/observability.example.yaml` must use these same numbers.
 * Operational only — nothing here describes a person or an identity decision.
 */

/** Operational CloudWatch Logs retention. Audit records are not these logs. */
export const LOG_RETENTION_DAYS = 30;

/** Non-5xx HTTP responses, excluding load-balancer probes. */
export const AVAILABILITY_SLO_PERCENT = 99.9;

/**
 * Page before the monthly budget is gone: three consecutive 5-minute windows
 * under this fast-burn floor.
 */
export const AVAILABILITY_FAST_BURN_PERCENT = 99;

/** Server duration, milliseconds, 95th percentile over the export window. */
export const HTTP_P95_MS = 800;

/** Malware-scan job duration, milliseconds, 95th percentile. */
export const SCAN_P95_MS = 60_000;

/** Page when any queue's waiting backlog exceeds this many jobs. */
export const QUEUE_DEPTH_ALARM = 100;

/** Page when the oldest queued job is older than this many seconds. */
export const QUEUE_OLDEST_AGE_SECONDS = 15 * 60;

/** Unscanned evidence older than this is past the handling target. */
export const QUARANTINE_OLDEST_AGE_SECONDS = 60 * 60;

/** ClamAV signature databases older than this are stale. */
export const CLAMAV_SIGNATURE_AGE_SECONDS = 2 * 24 * 60 * 60;

/**
 * Open DB connections for one application name. Default pool is 10 per
 * process; 16 is 80% of two web replicas.
 */
export const DB_POOL_OPEN_ALARM = 16;

/** Sustained 5xx responses in a one-minute window. */
export const HTTP_5XX_ALARM = 10;
