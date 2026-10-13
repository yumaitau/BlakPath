/**
 * Connection budget for the ap-southeast-2 data tier.
 *
 * `infra/aws/data-tier.example.yaml` pins `max_connections` and the default
 * instance classes to these values. `docs/data-tier-capacity.md` is the
 * operator note. RDS Proxy is not part of the tier: `src/db/client.ts` sets
 * `prepare: true`, which pins a proxy session for the life of each pooled
 * connection (issue #82).
 */

export const DATABASE_POOL_MAX = 10;
/** `src/db/migrate.ts` opens its own client with `max: 1`. */
export const MIGRATE_POOL_MAX = 1;
/** Issue #82: replica pools at the cap stay at or under this share of max_connections. */
export const CONNECTION_BUDGET_RATIO = 0.7;

export const DATA_TIER_CAPACITY = {
  region: 'ap-southeast-2',
  postgres: {
    instanceClass: 'db.m7g.large',
    engineVersion: '16.15',
    parameterGroupFamily: 'postgres16',
    maxConnections: 200,
    backupRetentionDays: 21,
  },
  redis: {
    nodeType: 'cache.m7g.large',
    engineVersion: '7.1',
    parameterGroupFamily: 'redis7',
    nodeCount: 2,
    maxmemoryPolicy: 'noeviction',
    snapshotRetentionLimit: 0,
  },
} as const;

export interface CapacityWorkload {
  name: string;
  /** HPA maxReplicas, or spec.replicas when the workload has no HPA. */
  maxReplicas: number;
  /** Extra pods RollingUpdate may add above maxReplicas. */
  rolloutSurge: number;
  poolMax: number;
}

/**
 * Web scale cap is the HPA (`infra/k8s/autoscaling.yaml`). Worker cap is
 * `spec.replicas` (`infra/k8s/worker-deployment.yaml`); it has no HPA.
 * Web surge is the deployment `maxSurge`. Worker surge is the Kubernetes
 * default (25% rounds up to 1 when replicas is 2).
 */
export const REPLICA_WORKLOADS: readonly CapacityWorkload[] = [
  {
    name: 'blakpath-app',
    maxReplicas: 4,
    rolloutSurge: 1,
    poolMax: DATABASE_POOL_MAX,
  },
  {
    name: 'blakpath-worker',
    maxReplicas: 2,
    rolloutSurge: 1,
    poolMax: DATABASE_POOL_MAX,
  },
];

/** Jobs are not always running. Peak still counts them so a seed can overlap a rollout. */
export const ONE_SHOT_JOBS: readonly CapacityWorkload[] = [
  {
    name: 'blakpath-migrate',
    maxReplicas: 1,
    rolloutSurge: 0,
    poolMax: MIGRATE_POOL_MAX,
  },
  {
    name: 'blakpath-seed',
    maxReplicas: 1,
    rolloutSurge: 0,
    poolMax: DATABASE_POOL_MAX,
  },
];

export function connectionCount(
  workloads: readonly CapacityWorkload[],
  includeSurge: boolean,
): number {
  return workloads.reduce((total, workload) => {
    const replicas = workload.maxReplicas + (includeSurge ? workload.rolloutSurge : 0);
    return total + replicas * workload.poolMax;
  }, 0);
}

/** Web and worker at their replica caps, no rollout surge and no Jobs. */
export function steadyReplicaConnections(): number {
  return connectionCount(REPLICA_WORKLOADS, false);
}

/** Rollout surge plus migrate and seed. */
export function peakConnections(): number {
  return connectionCount(REPLICA_WORKLOADS, true) + connectionCount(ONE_SHOT_JOBS, false);
}

export function connectionBudgetLimit(
  maxConnections: number = DATA_TIER_CAPACITY.postgres.maxConnections,
): number {
  return Math.floor(maxConnections * CONNECTION_BUDGET_RATIO);
}

export function withinConnectionBudget(connections: number): boolean {
  return connections <= connectionBudgetLimit();
}
