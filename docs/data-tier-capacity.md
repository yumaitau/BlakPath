# Data tier capacity

Region: `ap-southeast-2` only. Template: `infra/aws/data-tier.example.yaml`.
Numbers below are the same constants as `src/lib/data-tier-capacity.ts`.
Changing a replica cap, `DATABASE_POOL_MAX`, or `max_connections` means
updating the template, this note, and `tests/unit/data-tier-capacity.test.ts`
together.

This stack is an input for a human deploy. Nothing in CI calls AWS.
The `blakpath` namespace and `/api/ready` stay a deployment-owner step
until the CD pipeline (#57) can roll the manifests in `infra/k8s/`.

## Postgres

| Setting              | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Instance             | `db.m7g.large` (Graviton, 2 vCPU, 8 GiB). Not a burstable class.                      |
| Engine               | PostgreSQL `16.15` (family `postgres16`)                                              |
| `max_connections`    | `200` (parameter group, not the instance-class formula)                               |
| Storage              | 100 GiB gp3, autoscale ceiling 500 GiB                                                |
| Multi-AZ             | on                                                                                    |
| Deletion protection  | on                                                                                    |
| Encryption           | `alias/blakpath-rds` (rotation on). Not `aws/rds`. Same key for Performance Insights. |
| `rds.force_ssl`      | `1`                                                                                   |
| Backups              | 21 days, so point-in-time recovery is on. Window 16:00–17:00 UTC.                     |
| Performance Insights | on, 7-day retention                                                                   |
| Public access        | off. Subnets are the private subnets passed into the template.                        |
| RDS Proxy            | not created                                                                           |

`db.m7g.large` is the smallest non-burstable Graviton class in this generation.
The RDS memory formula would allow on the order of 900 connections. The
parameter group pins 200 so the budget below, not the formula, is the contract.
Do not raise `max_connections` on a smaller class.

PostgreSQL reserves `superuser_reserved_connections` (default 3) inside that 200. Clients cannot use those.

### Why there is no RDS Proxy

`src/db/client.ts` sets `prepare: true`. RDS Proxy pins the backend session
for the life of a pooled connection when the client uses prepared statements.
Pinning means the proxy does not reduce the connection count, and
`DatabaseConnectionsCurrentlySessionPinned` would track the pools. Peak load
already fits in `max_connections` without multiplexing. Multi-AZ covers
failover; the instance endpoint is what `DATABASE_URL` uses. Add a proxy only
with the `prepare: false` work in #82, and re-check session pinning before
calling that done.

### Connection budget

One process, one pool. Production sets `DATABASE_POOL_MAX=10` in
`infra/k8s/configmap.yaml` (the env default is also 10). Migrate does not use
that pool: `src/db/migrate.ts` opens `max: 1`. Seed uses the shared client, so
it takes up to 10.

| Workload           | Cap                   | Surge                       | Pool | Steady | Peak   |
| ------------------ | --------------------- | --------------------------- | ---- | ------ | ------ |
| `blakpath-app`     | HPA `maxReplicas` 4   | `maxSurge` 1                | 10   | 40     | 50     |
| `blakpath-worker`  | `replicas` 2 (no HPA) | default 25%, rounds up to 1 | 10   | 20     | 30     |
| `blakpath-migrate` | one Job               | —                           | 1    | —      | 1      |
| `blakpath-seed`    | one Job               | —                           | 10   | —      | 10     |
| **Total**          |                       |                             |      | **60** | **91** |

70% of 200 is 140. Steady (60) and peak (91) are both under that line.
Peak is a rollout at the HPA cap while migrate and seed are also connected.
Worker surge is not written in the manifest: Kubernetes defaults
`maxSurge` to 25% and rounds up.

Do not add a worker HPA, raise `DATABASE_POOL_MAX`, or raise web
`maxReplicas` without recomputing this table. Eight worker queues at
concurrency 4 share the pool of 10; they do not open 32 connections.
That queue depth is #82, not an extra connection charge here.

`DATABASE_URL` for `/blakpath/production/runtime`:

```text
postgres://blakpath:<password>@<endpoint>:5432/blakpath?sslmode=require
```

`sslmode=require` is what the release gate accepts today and what the server
forces with `rds.force_ssl=1`. `verify-full` waits on the RDS CA bundle in
#82. The password comes from the RDS-managed secret
(`MasterUserSecret`), encrypted with `alias/blakpath-app-secrets`. The
workload role does not read that secret. Copy the URL into the runtime secret.

## Redis

| Setting            | Value                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| Nodes              | `cache.m7g.large` × 2                                                         |
| Engine             | Redis OSS `7.1`, parameter family `redis7`                                    |
| Cluster mode       | off (`NumCacheClusters`, no `NumNodeGroups`). One primary URL for BullMQ.     |
| Failover           | automatic, Multi-AZ                                                           |
| In transit         | TLS on at create, so clients must use `rediss://`                             |
| At rest            | `alias/blakpath-elasticache` (rotation on)                                    |
| AUTH               | token (`AuthToken`). `describe-replication-groups` reports `AuthTokenEnabled` |
| `maxmemory-policy` | `noeviction`                                                                  |
| Snapshots          | retention 0. Redis is not a source of record.                                 |

`cache.m7g.large` is the smallest non-burstable node in this generation
(about 6 GiB). `noeviction` makes a full cache fail writes instead of
dropping BullMQ keys. Page when `DatabaseMemoryUsagePercentage` stays above 70. Do not switch the policy to an evicting mode.

AUTH is the token, not an RBAC user group. ElastiCache already has a regional
user named `default`. A new user group that still contains that user with
access left on would accept unauthenticated commands. The token requires every
connection to present a password. Move to RBAC only after `default` is set to
`off` in the account.

`REDIS_URL`:

```text
rediss://:<password>@<primary-endpoint>:6379
```

No username. The password is the `password` field of
`/blakpath/production/redis-auth`. Use the primary endpoint, not the reader.
ioredis reconnects on `READONLY` after failover.

## What a human applies

1. Confirm two private subnets in different AZs and the security groups that
   web, worker, and Jobs actually use. Pass one group twice when web and
   worker share it. Leave `JobSecurityGroupId` empty when Jobs use the worker
   group.
2. Pass the `alias/blakpath-app-secrets` key ARN as `SecretsKmsKeyArn`.
3. Deploy `infra/aws/data-tier.example.yaml` in `ap-southeast-2` only.
   This repository does not run that deploy.
4. Write `DATABASE_URL` and `REDIS_URL` into `/blakpath/production/runtime`.
   Do not commit the values.
5. Deploy the namespace with the CD pipeline (#57). Do not hand-roll a
   production apply ahead of that pipeline. Manifests are already in
   `infra/k8s/`.
6. Check the live account, then `/api/ready`:

```bash
aws rds describe-db-instances --region ap-southeast-2 \
  --db-instance-identifier blakpath-postgres \
  --query 'DBInstances[0].{MultiAZ:MultiAZ,DeletionProtection:DeletionProtection,Public:PubliclyAccessible,Kms:KmsKeyId,PI:PerformanceInsightsEnabled,Backup:BackupRetentionPeriod,Storage:StorageEncrypted}'

aws rds describe-db-parameters --region ap-southeast-2 \
  --db-parameter-group-name <postgres-parameter-group> \
  --query "Parameters[?ParameterName=='rds.force_ssl' || ParameterName=='max_connections'].[ParameterName,ParameterValue]"

aws elasticache describe-replication-groups --region ap-southeast-2 \
  --replication-group-id blakpath-redis \
  --query 'ReplicationGroups[0].{Transit:TransitEncryptionEnabled,AtRest:AtRestEncryptionEnabled,Auth:AuthTokenEnabled,Failover:AutomaticFailover,MultiAZ:MultiAZ}'

aws elasticache describe-cache-parameters --region ap-southeast-2 \
  --cache-parameter-group-name <redis-parameter-group> \
  --query "Parameters[?ParameterName=='maxmemory-policy'].[ParameterName,ParameterValue]"
```

`noeviction` is on the parameter group. `describe-replication-groups` returns
the group name, not the parameter value.

These keys are account CMKs with rotation on. Customer-held external key
material stays with #117.
