# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Layout

Manifests live in `infra/k8s`.

- `base` is environment-neutral. It has no account id and no ARN. Do not
  apply it on its own.
- `overlays/staging` renders namespace `blakpath-staging`, host
  `staging.blakpath.yumait.au`, and Secrets Manager path
  `/blakpath/staging/runtime`.
- `overlays/production` renders namespace `blakpath`, host
  `blakpath.yumait.au`, and Secrets Manager path
  `/blakpath/production/runtime`.
- Migrate and seed Jobs render from `overlays/<environment>/jobs`. They are
  not part of the main overlay.

The account id, ECR registry, image tag, evidence bucket, quarantine bucket
and evidence KMS key id are tokens. Private CD config substitutes them at
apply time. They are not committed.

## Deploy

1. Build the web and worker images and push them to ECR in ap-southeast-2
   with an immutable tag.
2. Create the Secrets Manager JSON for that environment:
   - staging: `/blakpath/staging/runtime`
   - production: `/blakpath/production/runtime`

   Keys match `infra/k8s/base/externalsecret.yaml` and
   `infra/k8s/base/secret.example.yaml`: `DATABASE_URL`, `REDIS_URL`,
   `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`, `SMTP_USER`,
   `SMTP_PASSWORD`, `PAPERBOY_API_KEY`, `EMAIL_WEBHOOK_SECRET`,
   `COA_SIGNING_KEY_ID`. External Secrets copies that JSON into the
   Kubernetes Secret `blakpath-runtime`.

3. Install External Secrets Operator and a ClusterSecretStore named
   `aws-secretsmanager` (the `secretStoreRef.name` in
   `externalsecret.yaml`). The platform ESO role stays shared and is never
   narrowed per app.
4. Export the private values for the target environment. Do not write them
   into the repo. `ECR_REGISTRY` is
   `<account-id>.dkr.ecr.ap-southeast-2.amazonaws.com`. Bucket names are the
   real buckets for that environment. `S3_KMS_KEY_ID` is the evidence key
   ARN in ap-southeast-2.

   ```sh
   export ECR_REGISTRY="<account-id>.dkr.ecr.ap-southeast-2.amazonaws.com"
   export IMAGE_TAG="<immutable-tag>"
   export S3_BUCKET_EVIDENCE="<evidence-bucket>"
   export S3_BUCKET_QUARANTINE="<quarantine-bucket>"
   export S3_KMS_KEY_ID="arn:aws:kms:ap-southeast-2:<account-id>:key/<key-id>"
   ```

   These manifests contain no WAF web ACL annotation and no workload role
   ARN. TLS, WAF and the Pod Identity or IRSA association stay in account
   and cluster config outside this public base. See `infra/aws/README.md`.

5. Render, substitute and apply. Production:

   ```sh
   kubectl kustomize infra/k8s/overlays/production \
     | sed \
       -e "s|__ECR_REGISTRY__|${ECR_REGISTRY}|g" \
       -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
       -e "s|__PRODUCTION_S3_BUCKET_EVIDENCE__|${S3_BUCKET_EVIDENCE}|g" \
       -e "s|__PRODUCTION_S3_BUCKET_QUARANTINE__|${S3_BUCKET_QUARANTINE}|g" \
       -e "s|__PRODUCTION_S3_KMS_KEY_ID__|${S3_KMS_KEY_ID}|g" \
     | kubectl apply -f -
   ```

   Staging uses `infra/k8s/overlays/staging` and the `__STAGING_*` tokens:
   `__STAGING_S3_BUCKET_EVIDENCE__`, `__STAGING_S3_BUCKET_QUARANTINE__`,
   `__STAGING_S3_KMS_KEY_ID__`. Values must not contain `|`.

6. Run the migration and catalogue seed from the jobs overlay. Same image
   substitution, without the bucket or KMS tokens:

   ```sh
   kubectl kustomize infra/k8s/overlays/production/jobs \
     | sed \
       -e "s|__ECR_REGISTRY__|${ECR_REGISTRY}|g" \
       -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
     | kubectl apply -f -
   ```

   Use `infra/k8s/overlays/staging/jobs` for staging. Re-applying a finished
   Job fails until the old Job is deleted. That is why Jobs stay out of the
   main overlay.

7. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 credentials. The SDK uses the workload
   identity chain.
8. Verify `/api/ready` behind the ALB, sign in, select an org, and confirm
   the audit chain is clean.

## Staging

Staging is a separate namespace, secret, host, buckets and KMS key from
production. A staging render has no production secret path and no `arn:aws`
value. Evidence journeys that need object storage and cannot run on local
MinIO are covered here (`docs/e2e-journeys.md`). Council onboarding runs
`tests/e2e/team-isolation.spec.ts` against this environment
(`docs/council-onboarding.md`).

Before the first apply, create the staging secret, buckets, KMS key and DNS
name `staging.blakpath.yumait.au`. Do not point staging at production
buckets or the production evidence key. If staging mail must not use the
production PaperBoy, override `PAPERBOY_URL` from private CD config.

## Secrets and keys

- Each environment keeps its secrets under `/blakpath/staging/` or
  `/blakpath/production/` in Secrets Manager. The app reads the synced
  Kubernetes Secret `blakpath-runtime`.
- Customer keys differ by environment. Production encrypts the Secrets
  Manager folder with `alias/blakpath-app-secrets`. Staging uses
  `alias/blakpath-staging-app-secrets`. Production evidence and quarantine
  buckets use `alias/blakpath-prod-evidence`. Staging uses
  `alias/blakpath-staging-evidence`. RDS uses its provisioned key. No
  AWS-managed default key on the secret path. The key ARN is the private
  `S3_KMS_KEY_ID` value, not a committed manifest field.
- ElastiCache runs with transit and at-rest encryption. Redis holds
  ephemeral state only — never tenant records.

## Data services

- RDS Postgres with point-in-time recovery. Proxy in front for failover.
- ElastiCache Redis TLS. Ephemeral only: queues, rate limits, schedulers.
- S3 evidence + quarantine buckets: block public access, enforce TLS + CMK,
  versioning on, AWS Backup coverage. MinIO exists for local dev only.
  Bucket names come from the overlay tokens, not from the public base.
- SES in ap-southeast-2 with SNS bounce/complaint topic wired to
  `POST /api/email/events` (shared-secret gated, persisted suppressions).
- PaperBoy (`https://paperboy.yumait.au`) is the production mail sender.
  Create an API key there, store it as `PAPERBOY_API_KEY` in
  `/blakpath/production/runtime`, and keep `PAPERBOY_URL` in the ConfigMap.
  Sender contract: `POST {PAPERBOY_URL}/api/v1/emails` with
  `Authorization: Bearer <key>` and a JSON body of
  `{from, to, subject, text}`. Wiring the sender to PaperBoy is tracked work.
  Until then, mail flows through the SES API under the workload role.

## CoA signing key (KMS)

Certificates are sealed with an asymmetric KMS key and verified publicly
against its public key. Private key material never leaves KMS.

1. Create the key: RSA_2048 (or ECC_NIST_P256), usage SIGN_VERIFY, in
   ap-southeast-2. Production alias: `alias/blakpath-coa-signing`. Staging
   alias: `alias/blakpath-staging-coa-signing`.
2. Grant the workload role `kms:Sign`, `kms:Verify`, `kms:GetPublicKey`,
   `kms:DescribeKey` on that key. The Pod Identity or IRSA association is
   cluster config and is not stored in these manifests.
3. Set `COA_SIGNING_KEY_ID` to the key ARN in the environment runtime
   secret (`/blakpath/production/runtime` or `/blakpath/staging/runtime`).
4. Rotate by creating a new key version or alias target. Existing seals
   verify against their stored `signingKeyId`, so rotation never invalidates
   issued certificates. Local development and CI use
   `COA_SIGNING_LOCAL_KEY_PEM`, which the app refuses in production.

## Restore drill (EKS variant)

1. Snapshot RDS + S3 point-in-time into an isolated namespace with a
   separate secret copy. Never restore into `blakpath` or `blakpath-staging`.
2. Run migrations, sign in as seeded admin, confirm records present.
3. Download clean evidence through the normal authorised path (quarantine
   blocks bypass). Run audit-verify and expect a clean chain.
4. Record date, operator, source, target, elapsed RTO and verification
   result outside the restored environment.

## Alarms

Audit divergence, scan backlog past handling target, dead-letter email/export/
retention/webhook jobs, backup failures, sustained 5xx / readiness failures.
See `infra/aws/operational-alerts.example.yaml` for signal mapping.
