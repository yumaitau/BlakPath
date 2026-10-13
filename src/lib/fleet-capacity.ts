/**
 * Fleet capacity shared by the process pool and infra/k8s.
 *
 * tests/unit/fleet-capacity.test.ts fails when the manifests drift from
 * these values. HPA max is the largest web replica count whose rollout peak
 * stays under 80% of RDS max_connections.
 *
 * Sizing floor is a 1 GiB RDS for PostgreSQL instance (db.t4g.micro default
 * in ap-southeast-2). Default max_connections is
 * LEAST({DBInstanceClassMemory/9531392}, 5000) = 112.
 * A larger class still satisfies the budget. A parameter group that lowers
 * max_connections does not: change the floor here and the manifests together.
 *
 * Peak counts connections that stay open during a rolling deploy. Web
 * maxUnavailable is 0, so the surged pod and the pod in preStop both hold a
 * pool. Worker rollout surges by one as well. migrate.ts holds one more
 * connection. The remaining headroom covers superuser_reserved_connections,
 * RDS monitoring, and a seed job that must not run during a rollout at max.
 */

/** postgres.js pool per web or worker process. */
export const DATABASE_POOL_MAX = 10;

/** 1 GiB. AWS DBInstanceClassMemory for db.t4g.micro / db.t3.micro. */
export const RDS_FLOOR_MEMORY_BYTES = 1024 * 1024 * 1024;

/** RDS PostgreSQL default divisor for max_connections. */
export const RDS_MAX_CONNECTIONS_DIVISOR = 9_531_392;

export const RDS_MAX_CONNECTIONS_CAP = 5_000;

/** Peak connections must stay strictly under this fraction of max_connections. */
export const CONNECTION_BUDGET_RATIO = 0.8;

export const WEB_MIN_REPLICAS = 2;
export const WEB_MAX_SURGE = 1;
export const WORKER_REPLICAS = 2;
export const WORKER_MAX_SURGE = 1;

/** src/db/migrate.ts opens a single connection. */
export const MIGRATION_CONNECTIONS = 1;

/**
 * ALB target-group deregistration delay, in seconds. The web preStop sleeps
 * for the same interval so the process outlives in-flight requests.
 */
export const ALB_DRAIN_SECONDS = 15;

/**
 * How long worker/index.ts waits for in-flight jobs after SIGTERM.
 * Workers do not use a preStop sleep: SIGTERM is what starts this drain.
 */
export const WORKER_SHUTDOWN_GRACE_SECONDS = 25;

/**
 * Worker terminationGracePeriodSeconds. No preStop, so the whole period is
 * available after SIGTERM. Must exceed WORKER_SHUTDOWN_GRACE_SECONDS.
 */
export const WORKER_TERMINATION_GRACE_PERIOD_SECONDS = 30;

/**
 * Web terminationGracePeriodSeconds. The kubelet starts this clock at
 * deletion and preStop runs inside it, so the period is the ALB drain plus
 * the worker's post-SIGTERM shutdown window.
 */
export const TERMINATION_GRACE_PERIOD_SECONDS =
  ALB_DRAIN_SECONDS + WORKER_SHUTDOWN_GRACE_SECONDS;

export function rdsDefaultMaxConnections(memoryBytes: number): number {
  if (!Number.isInteger(memoryBytes) || memoryBytes <= 0) {
    throw new Error('RDS memory must be a positive integer number of bytes');
  }
  return Math.min(
    Math.floor(memoryBytes / RDS_MAX_CONNECTIONS_DIVISOR),
    RDS_MAX_CONNECTIONS_CAP,
  );
}

/** Connections held when web is at maxReplicas and both deployments are surging. */
export function peakDbConnections(webMaxReplicas: number): number {
  const processes = webMaxReplicas + WEB_MAX_SURGE + WORKER_REPLICAS + WORKER_MAX_SURGE;
  return processes * DATABASE_POOL_MAX + MIGRATION_CONNECTIONS;
}

/**
 * Largest web HPA maxReplicas whose rollout peak fits under
 * CONNECTION_BUDGET_RATIO of maxConnections.
 */
export function maxWebReplicas(
  maxConnections = rdsDefaultMaxConnections(RDS_FLOOR_MEMORY_BYTES),
): number {
  const budget = maxConnections * CONNECTION_BUDGET_RATIO;
  if (peakDbConnections(WEB_MIN_REPLICAS) >= budget) {
    throw new Error(
      `connection budget ${budget} cannot fit ${WEB_MIN_REPLICAS} web replicas`,
    );
  }
  let replicas = WEB_MIN_REPLICAS;
  while (peakDbConnections(replicas + 1) < budget) {
    replicas += 1;
  }
  return replicas;
}
