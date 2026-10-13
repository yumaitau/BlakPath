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
2. Grant the workload role `kms:Sign` and `kms:GetPublicKey` on the key ARN
   (Pod Identity association). Signing needs nothing else; public
   verification needs no KMS access at all.
3. Set `COA_SIGNING_KEY_ID` to the alias (`alias/blakpath-coa-signing`) or the
   key ARN in `blakpath-eks-runtime`.
4. Every seal stores the resolved key ARN KMS reports it signed with (never
   the alias), and the first seal by a key stores that key's public half
   (SPKI + SHA-256 fingerprint) in `signing_keys`. `/verify` checks seals
   offline against that stored public key — zero KMS calls per request.

Rotation. KMS does not rotate asymmetric keys in place, so rotation is a new
key plus an alias retarget:

1. Create a new SIGN_VERIFY key (same spec) and grant the workload role
   `kms:Sign` and `kms:GetPublicKey` on it.
2. Retarget the alias: `aws kms update-alias --alias-name
alias/blakpath-coa-signing --target-key-id <new-key-id>` (or, if
   `COA_SIGNING_KEY_ID` holds an ARN, point it at the new ARN and restart).
   The next seal records the new ARN and its public key automatically.
3. Earlier certificates keep verifying from their stored public keys, so the
   old key can then be disabled and scheduled for deletion once the backfill
   below reports nothing outstanding. Do not delete a key whose public half
   is not in `signing_keys`.

Seals made before `signing_keys` existed carry the alias/env value and have no
stored public key, so `/verify` shows them "Not verified" until backfilled.
While every old key is still enabled, run
`pnpm certificates:backfill-signing-keys` (dry run), then with `--apply`.
If the alias was already retargeted, append the previous key ARN as an extra
candidate. Each seal is re-verified against a candidate key before its
`signing_key_id` is rewritten to that ARN; nothing is re-signed.

Local development and CI use `COA_SIGNING_LOCAL_KEY_PEM`, which the app
refuses in production.

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
