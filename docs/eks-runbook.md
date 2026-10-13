# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

Pushes to `main` run `.github/workflows/cd.yml`. See `docs/cd.md`. The workflow
assumes an IAM role with GitHub OIDC, pushes the web and worker images to ECR
by digest, attests provenance and an SBOM, deploys staging, then waits for the
protected `production` environment. The cluster order is release gate, migrate,
digest-pinned rollout, smoke (`/api/ready` and sign-in), and workload rollback
if smoke fails. Migrations are not reversed.

One-time bootstrap, before that pipeline has a Deployment to update:

1. Apply `infra/aws/github-oidc-cd.example.yaml` in `ap-southeast-2`. Set
   GitHub variable `AWS_CD_ROLE_ARN` to the output. Do not create access keys.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` and
   `/blakpath/staging/runtime` with `DATABASE_URL`, `REDIS_URL`,
   `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`, `SMTP_USER`, `SMTP_PASSWORD`,
   `EMAIL_WEBHOOK_SECRET`.
3. Install External Secrets Operator and the cluster secret store.
4. Create namespaces `blakpath` and `blakpath-staging`. Apply
   `infra/k8s/overlays/production` and `infra/k8s/overlays/staging` once the
   staging CMK placeholder has been replaced. After this, the pipeline changes
   images by digest; do not re-apply the old mutable tags.
5. `pnpm release:check` runs inside the worker image as the release-gate Job.
   It rejects static S3 credentials. The SDK uses the workload role.
6. Confirm `/api/ready`, sign-in, and a clean audit chain. Production also
   records a git tag and the image digests on the GitHub Release.

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
