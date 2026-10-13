# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images from the same commit, push to ECR
   ap-southeast-2, and record both digests. The migrate Job uses the **app**
   image digest, not a separate tag and not the worker image.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with the
   application role in `DATABASE_URL` (`blakpath_app`), plus `REDIS_URL`,
   `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`, `SMTP_USER`,
   `SMTP_PASSWORD`, `EMAIL_WEBHOOK_SECRET`.
3. Create `/blakpath/production/migrator` with only `DATABASE_MIGRATOR_URL`
   (`blakpath_migrator`). Apply `infra/postgres/roles.sql` once as the RDS
   master before the first migrate. Do not copy the migrator URL into the
   runtime secret.
4. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
5. Release with `scripts/cd-release.sh`. It renders a per-release Job
   (`blakpath-migrate-<git sha>`, `ttlSecondsAfterFinished` 86400) from the
   app digest, waits until the Job succeeds, and only then applies the web
   and worker Deployments at those digests. A failed Job does not roll the
   Deployments. `DRY_RUN=1` renders without applying.
6. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 credentials and a migrator URL on the app.
   The SDK uses the IRSA task role chain.
7. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.

Image tags in `infra/k8s/kustomization.yaml` are local defaults. A release
replaces them with digests. Do not `kubectl apply` `infra/k8s/jobs/migrate.yaml`
by hand.

## Rollback

Migrations are forward-only. Roll back code by redeploying the previous image
digest. Do not write a down migration. Point-in-time recovery is only for
data corruption, and never into the live namespace.

Release N-1 must still run on schema N. That is the expand/contract rule in
`docs/database-migrations.md`: a release may add tables, nullable columns,
concurrent indexes and `NOT VALID` foreign keys. It may not drop, rename or
tighten columns the previous release still uses. The contract (drop the old
shape) waits until N-1 is gone.

1. If the migrate Job failed, stop. `scripts/cd-release.sh` has not changed
   Deployments. Transactional DDL rolled back. Fix the migration forward and
   release again. A lock wait aborts in under five seconds
   (`lock_timeout` 4s) instead of stalling the rollout.
2. If the new code is up and misbehaving but the data is intact, point the
   web and worker Deployments back at the previous digests. Do not run a
   migrate Job for that rollback. Schema stays at N. The previous digest
   still works because N was expand-only. Confirm `/api/ready`, sign-in and
   one staff flow.
3. If a migration committed bad or destroyed data, stop writes, take a fresh
   recovery point, and restore into a new isolated namespace using the
   restore drill below. Promote that namespace only after sign-in, tenant
   records, evidence authorisation and the audit chain verify. Do not restore
   over the live database.

Staging still needs one human rehearsal of steps 1 and 2 against the staging
cluster. A disposable-Postgres rehearsal of the same steps is recorded in
`docs/migration-drills/` when it has been run. The cluster rehearsal is not
something this repository can apply by itself.

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

- RDS Postgres with point-in-time recovery. Proxy in front for failover.
  Two roles: `blakpath_migrator` (owner, migrate Job only) and
  `blakpath_app` (runtime DML). See `infra/postgres/roles.sql`.
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
