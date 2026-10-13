# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL` (`sslmode=verify-full`, `verify-ca`, or `require`),
   `REDIS_URL` (`rediss`), `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`,
   `EMAIL_WEBHOOK_SECRET`, `PAPERBOY_API_KEY`, and `COA_SIGNING_KEY_ID`
   (KMS key ARN in ap-southeast-2). Do not set `SMTP_USER`, `SMTP_PASSWORD`,
   `PILOT_BOOTSTRAP_TOKEN`, `COA_SIGNING_LOCAL_KEY_PEM`, or static S3 keys.
3. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
4. Build and push the web and worker images. Both contain `release-check.cjs`.
   Roll out with the Deploy workflow or `scripts/eks-deploy.sh <tag>`.
   The script applies namespace, config, and ExternalSecret, runs the
   release-check Job in those images with the production ConfigMap and Secret,
   and applies `infra/k8s` only after the Job exits 0. A failed gate does not
   roll the workloads. `kubectl apply -k infra/k8s` alone skips that gate.
5. The gate rejects static S3 and SMTP credentials. Object storage and the SES
   API use the workload role.
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

- RDS Postgres with point-in-time recovery. Proxy in front for failover.
- ElastiCache Redis TLS. Ephemeral only: queues, rate limits, schedulers.
- S3 evidence + quarantine buckets: block public access, enforce TLS + CMK,
  versioning on, AWS Backup coverage. MinIO exists for local dev only.
- SES in ap-southeast-2 with SNS bounce/complaint topic wired to
  `POST /api/email/events` (shared-secret gated, persisted suppressions).
- PaperBoy (`https://paperboy.yumait.au`) is configured with `PAPERBOY_URL`
  in the ConfigMap. Because that URL is set, the release gate requires
  `PAPERBOY_API_KEY` in the runtime secret. Sender contract:
  `POST {PAPERBOY_URL}/api/v1/emails` with `Authorization: Bearer <key>` and a
  JSON body of `{from, to, subject, text}`. Wiring the sender to PaperBoy is
  tracked work; until then mail flows through the SES API under the workload
  role. Do not put `SMTP_USER` or `SMTP_PASSWORD` in the runtime secret.

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
