/**
 * Production connection budget for the EKS shape in `infra/k8s/`.
 *
 * At HPA max, web replicas × web pool + worker replicas × worker pool + one
 * migration connection must stay at or below 70% of RDS `max_connections`.
 * Rollout surge is held to the same cap. There is no worker HPA; worker
 * capacity is the deployment replica count.
 *
 * RDS default is `LEAST({DBInstanceClassMemory/9531392}, 5000)`. A 2 GiB
 * instance (db.t4g.small) yields 225. A smaller class does not fit this budget.
 * The worker pool is one connection per in-flight job (queues × concurrency)
 * so a job is not stuck behind a shared pool of 10.
 */

export const WEB_POOL_MAX = 10;
export const WORKER_POOL_MAX = 32;
/** One BullMQ worker per queue, this many jobs at once. See `worker/index.ts`. */
export const WORKER_QUEUE_CONCURRENCY = 4;
export const WEB_HPA_MIN_REPLICAS = 2;
export const WEB_HPA_MAX_REPLICAS = 4;
export const WEB_MAX_SURGE = 1;
export const WORKER_REPLICAS = 2;
export const WORKER_MAX_SURGE = 1;
export const MIGRATION_CONNECTIONS = 1;
/** Minimum `max_connections` this budget is checked against. */
export const RDS_MAX_CONNECTIONS = 225;
export const CONNECTION_BUDGET_FRACTION = 0.7;

export function clientConnections(input: {
  webReplicas: number;
  workerReplicas: number;
}): number {
  return (
    input.webReplicas * WEB_POOL_MAX +
    input.workerReplicas * WORKER_POOL_MAX +
    MIGRATION_CONNECTIONS
  );
}

export function connectionBudgetLimit(maxConnections = RDS_MAX_CONNECTIONS): number {
  return Math.floor(maxConnections * CONNECTION_BUDGET_FRACTION);
}
