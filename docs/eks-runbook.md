# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`,
   `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_WEBHOOK_SECRET`.
3. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
4. Set image tags and host, apply: `kubectl kustomize infra/k8s | kubectl apply -f -`
   after replacing `ACCOUNT_ID`, `TAG`, host, role ARNs, WAF ACL ARN.
5. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 credentials; SDK uses IRSA task role chain.
6. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.

## Secrets and keys

- Dedicated folder: every BlakPath secret lives under
  `/blakpath/production/` in Secrets Manager. The app reads a single synced
  `blakpath-runtime` Secret via External Secrets Operator; the platform ESO
  role stays shared and is never narrowed per app.
- Customer keys everywhere: `alias/blakpath-app-secrets` encrypts the
  Secrets Manager folder, EBS volumes by default, and ElastiCache at rest.
  `alias/blakpath-prod-evidence` covers both S3 buckets. RDS uses its
  provisioned key. No AWS-managed default keys in the secret path.
- ElastiCache runs with transit and at-rest encryption. Redis holds
  ephemeral state only — never tenant records.

## Data services

- RDS Postgres with point-in-time recovery. RDS Proxy in front for failover.
  Clients connect to the proxy hostname, not an IP and not a CNAME that is
  absent from the certificate.
- TLS is `sslmode=verify-full`. The web and worker images bake
  `certs/rds-global-bundle.pem` (the public Amazon RDS global bundle) and set
  `ssl: { ca, rejectUnauthorized: true }`. The release gate rejects
  `require`, `verify-ca`, and any missing mode. `require` is not verification:
  postgres.js maps it to `rejectUnauthorized: false`.
- Session timeouts are startup parameters, not `SET` (a PostgreSQL `SET` pins
  an RDS Proxy session). App connections use `statement_timeout=60s`,
  `lock_timeout=10s`, `idle_in_transaction_session_timeout=30s`. Migrations use
  a 10 minute statement cap on their own single connection.
- Named prepared statements are off (`prepare: false`). RDS Proxy can multiplex
  the extended query protocol, but SQL `PREPARE`/`EXECUTE` still pins, and
  older proxies pinned named protocol statements. The client never issues those.
- ElastiCache Redis TLS. Ephemeral only: queues, rate limits, schedulers.
- S3 evidence + quarantine buckets: block public access, enforce TLS + CMK,
  versioning on, AWS Backup coverage. MinIO exists for local dev only.
- SES in ap-southeast-2 with SNS bounce/complaint topic wired to
  `POST /api/email/events` (shared-secret gated, persisted suppressions).
- PaperBoy (`https://paperboy.yumait.au`) is the production mail sender:
  create an API key there, store it as `PAPERBOY_API_KEY` in
  `blakpath-eks-runtime`, and keep `PAPERBOY_URL` in the ConfigMap. Sender
  contract: `POST {PAPERBOY_URL}/api/v1/emails` with
  `Authorization: Bearer <key>` and a JSON body of
  `{from, to, subject, text}`. Wiring the sender to PaperBoy is tracked work;
  until then mail flows through the SES API under the workload role.

## Database connection budget

Checked in `src/db/connection-budget.ts` and `tests/unit/connection-budget.test.ts`.
The instance must provide at least 225 `max_connections`. That is the RDS
default for 2 GiB (`LEAST({DBInstanceClassMemory/9531392}, 5000)`), so
`db.t4g.small` or larger. Do not use a smaller class without lowering the
pools and updating the budget test. Leave `max_connections` at the default on
that size or larger.

| Process                            | Replicas at HPA max | Pool | Connections          |
| ---------------------------------- | ------------------- | ---- | -------------------- |
| Web (`blakpath-app`)               | 4                   | 10   | 40                   |
| Worker (`blakpath-worker`, no HPA) | 2                   | 32   | 64                   |
| Migration job                      | 1                   | 1    | 1                    |
| **Steady total**                   |                     |      | **105** (46% of 225) |

Rollout surge is web `maxSurge: 1` (5 × 10) and worker `maxSurge: 1` (3 × 32)
plus the migration connection: 147, which is 65% of 225. Both stay at or under
70% (157). The worker pool is 8 queues × concurrency 4, so each in-flight job
can hold a connection.

`DATABASE_URL` in the runtime secret must include `sslmode=verify-full`.
`DATABASE_POOL_MAX=10` is in the ConfigMap. The worker deployment sets
`BLAKPATH_PROCESS=worker` and `DATABASE_WORKER_POOL_MAX=32`.

After the proxy is in service, under load, confirm CloudWatch
`DatabaseConnectionsCurrentlySessionPinned` stays near zero. This repository
does not create the proxy or run that load. A non-zero metric means some
session state is pinning (a `SET`, SQL `PREPARE`, a temporary table, or a
session advisory lock). Transaction-scoped advisory locks
(`pg_advisory_xact_lock`) do not pin.

## CoA signing key (KMS)

Certificates are sealed with an asymmetric KMS key and verified publicly
against its public key — private key material never leaves KMS.

1. Create the key: RSA_2048 (or ECC_NIST_P256), usage SIGN_VERIFY, alias
   `alias/blakpath-coa-signing`, ap-southeast-2.
2. Grant the workload role `kms:Sign`, `kms:Verify`, `kms:GetPublicKey`,
   `kms:DescribeKey` on the key ARN (Pod Identity association).
3. Set `COA_SIGNING_KEY_ID` to the key ARN in `blakpath-eks-runtime`.
4. Rotate by creating a new key version/alias target; existing seals verify
   against their stored `signingKeyId`, so rotation never invalidates issued
   certificates. Local development and CI use `COA_SIGNING_LOCAL_KEY_PEM`,
   which the app refuses in production.

## Restore drill (EKS variant)

1. Snapshot RDS + S3 point-in-time into isolated namespace with separate
   secret copy. Never restore into live namespace.
2. Run migrations, sign in as seeded admin, confirm records present.
3. Download clean evidence through normal authorised path (quarantine blocks
   bypass). Run audit-verify, expect clean chain.
4. Record date, operator, source, target, elapsed RTO, verification result
   outside restored environment.

## Alarms

Audit divergence, scan backlog past handling target, dead-letter email/export/
retention/webhook jobs, backup failures, sustained 5xx / readiness failures.
See `infra/aws/operational-alerts.example.yaml` for signal mapping.
