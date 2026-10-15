# Data tier capacity

Region: `ap-southeast-2` only. Template: `infra/aws/data-tier.example.yaml`.
The connection budget is `src/db/connection-budget.ts`, checked by
`tests/unit/connection-budget.test.ts` and described in `docs/eks-runbook.md`
(Database connection budget). `tests/unit/data-tier-capacity.test.ts` checks
that this template still fits it.

This stack is an input for a human deploy. Nothing in CI calls AWS.
The `blakpath` namespace and `/api/ready` stay a deployment-owner step
until the CD pipeline (#57) can roll the manifests in `infra/k8s/`.

## Postgres

| Setting              | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Instance             | `db.m7g.large` (Graviton, 2 vCPU, 8 GiB). Not a burstable class.                      |
| Engine               | PostgreSQL `16.15` (family `postgres16`)                                              |
| `max_connections`    | RDS default for the class (about 900 on 8 GiB). Not pinned.                           |
| Storage              | 100 GiB gp3, autoscale ceiling 500 GiB                                                |
| Multi-AZ             | on                                                                                    |
| Deletion protection  | on                                                                                    |
| Encryption           | `alias/blakpath-rds` (rotation on). Not `aws/rds`. Same key for Performance Insights. |
| `rds.force_ssl`      | `1`                                                                                   |
| Backups              | 21 days, so point-in-time recovery is on. Window 16:00–17:00 UTC.                     |
| Performance Insights | on, 7-day retention                                                                   |
| Public access        | off. Subnets are the private subnets passed into the template.                        |
| RDS Proxy            | not created by this template (see the runbook)                                        |

`db.m7g.large` is the smallest non-burstable Graviton class in this generation.
The connection budget needs at least `RDS_MAX_CONNECTIONS` (225), the RDS
default on a 2 GiB class. Leave `max_connections` at the default; do not pick a
class under 2 GiB.

PostgreSQL reserves `superuser_reserved_connections` (default 3) inside that
limit. Clients cannot use those.

### RDS Proxy and TLS

The client runs with `prepare: false` and session timeouts as startup
parameters, so an RDS Proxy does not pin sessions. The proxy itself is not part
of this template. Clients connect to the RDS or proxy DNS name with
`sslmode=verify-full` against the baked RDS CA bundle.

`DATABASE_URL` for `/blakpath/production/runtime`:

```text
postgres://blakpath_app:<password>@<rds-or-proxy-endpoint>:5432/blakpath?sslmode=verify-full
```

The template's master user (`MasterUserSecret`, encrypted with
`alias/blakpath-app-secrets`) only runs `infra/postgres/audit-roles.sql`.
It is not the runtime user. The migrate Job reads `DATABASE_MIGRATION_URL`
(`blakpath_migrator`) from its own secret. The workload role does not read
the master secret.

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

`alias/blakpath-rds` and `alias/blakpath-elasticache` are platform CMKs for
the volume, with rotation on. They do not replace tenant keys: tenant fields
inside the database are sealed with each organisation's own key
(`organisation_keys`, customer-held with optional escrow). See
`docs/customer-held-keys.md`. Redis never holds tenant field contents.
