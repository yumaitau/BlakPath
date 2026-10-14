# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL` (role `blakpath_app`), `REDIS_URL`, `BETTER_AUTH_SECRET`,
   `ENCRYPTION_MASTER_KEY`, `EMAIL_WEBHOOK_SECRET`, `ORIGIN_VERIFY_SECRET`,
   `AUDIT_ANCHOR_SIGNING_KEY_ID`. `EMAIL_SNS_TOPIC_ARN` is not a secret; it
   lives in the ConfigMap. Do not store `SMTP_USER` or `SMTP_PASSWORD`.
   Create a separate secret at `/blakpath/production/migrator` with only
   `DATABASE_MIGRATION_URL` (role `blakpath_migrator`). Do not put the
   migrator URL in the runtime secret.
3. In `infra/aws/eks-boundary.example.yaml`, replace `OIDC_ID` with the cluster
   OIDC issuer id. Deploy that stack in ap-southeast-2.
   `CreatePodIdentityAssociation` stays `false` until the namespace exists.
   `PlatformEsoRoleName` is the shared External Secrets role, never
   `blakpath-external-secrets` or the workload role.
4. Replace `CLUSTER_NAME` in
   `infra/aws/blakpath-eks-runtime-trust.example.json` and set that document as
   the trust policy on `blakpath-eks-runtime`.
5. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
6. Set image tags and host, apply: `kubectl kustomize infra/k8s | kubectl apply -f -`
   after replacing `ACCOUNT_ID`, `TAG`, host, role ARNs, certificate ARN,
   trust store ARN and WAF ACL ARN. Complete the edge section below first.
   Rolling the app before the origin-verify header is live makes production
   requests return 403.
7. Delete any pod identity association for `blakpath/blakpath` that was left
   behind while the namespace did not exist. Update the stack with
   `CreatePodIdentityAssociation=true` and the real `WorkloadRoleArn`.
8. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 credentials, standing SMTP credentials and
   `PILOT_BOOTSTRAP_TOKEN`. SDK uses the workload role. Do not put
   `PILOT_BOOTSTRAP_TOKEN` in the runtime secret.
9. Apply the migrate job, then the seed job, then
   `infra/k8s/jobs/invite-admin.yaml` with the first administrator's email.
   The job emails an organisation-administrator invitation and does not create
   a password. That person enrols a passkey or authenticator before the
   organisation tools open.
10. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.

## Edge and origin

Do this before the deployment above accepts production traffic. The listener
manifest is `infra/k8s/service-ingress.yaml`. The example stack is
`infra/aws/origin-edge.example.yaml`.

1. Create a private CA and a client certificate signed by it. Keep the private
   key out of git. Upload that client certificate to Cloudflare as a
   **zone-level or per-hostname** Authenticated Origin Pull for
   `blakpath.yumait.au`. Do not use the global Authenticated Origin Pull
   certificate: it is shared by every Cloudflare account.
2. Upload only the CA certificate PEM to a private S3 object. Deploy
   `origin-edge.example.yaml` in `ap-southeast-2`. Publish the ACM DNS
   validation record in the zone as DNS-only, and wait until the certificate
   is issued.
3. Set the zone SSL/TLS mode to **Full (strict)**.
4. Generate `ORIGIN_VERIFY_SECRET` (at least 32 characters). Store it only in
   the runtime secret. Add a Cloudflare request-header transform for the
   hostname that sets `x-blakpath-origin-verify` to that value on the request
   to the origin. Do not put the value in a response header or in git.
5. Substitute `CertificateArn`, `TrustStoreArn` and `WebAclArn` into the
   ingress annotations, then apply. Port 80 redirects to 443. Port 443 uses
   TLS 1.2 and 1.3, drops invalid header fields, removes `X-Forwarded-For`,
   requires the zone client certificate, and attaches the regional WAF ACL.
6. Check from outside the cluster: `curl -sI http://<alb-dns>` returns a
   redirect and not the application; `curl -sI https://<alb-dns>` without the
   client certificate is rejected. A request that presents the secret records
   `CF-Connecting-IP`. A different `X-Forwarded-For` value does not change it.

## Secrets and keys

- Dedicated folder: every BlakPath secret lives under
  `/blakpath/production/` in Secrets Manager. The app reads one synced
  `blakpath-runtime` Secret. The store is namespace-local
  (`infra/k8s/secretstore.yaml`). Its role
  `blakpath-external-secrets` can read that folder only, and only when the
  IRSA subject is `system:serviceaccount:blakpath:blakpath-external-secrets`.
- The shared External Secrets role is denied `GetSecretValue` on
  `secret:/blakpath/production/*` and `kms:Decrypt` on
  `alias/blakpath-app-secrets`. Do not point BlakPath at the cluster-wide
  store.
- After the deny is in place, an ExternalSecret for
  `/blakpath/production/runtime` outside namespace `blakpath` must fail with
  AccessDenied. Delete that check object. Do not print Secret data.
- Customer keys everywhere: `alias/blakpath-app-secrets` encrypts the
  Secrets Manager folder, EBS volumes by default, and ElastiCache at rest.
  `alias/blakpath-prod-evidence` covers both S3 buckets. RDS uses its
  provisioned key. No AWS-managed default keys in the secret path. The key
  policy keeps account-root IAM delegation so the dedicated role's IAM allow
  works. Do not grant the shared External Secrets role on that key.
- ElastiCache runs with transit and at-rest encryption. Redis holds
  ephemeral state only — never tenant records.

## Mail credentials

Production mail uses `ses:SendEmail` on `blakpath-eks-runtime`, limited to
`ses:FromAddress` `no-reply@blakpath.yumait.au`. The stack does not create an
SMTP user or an access key.

Retire the standing user `blakpath-ses-smtp`:

1. Delete its access keys.
2. Detach `AmazonSESFullAccess` and any other SES policy.
3. Delete the user.
4. Remove `SMTP_USER` and `SMTP_PASSWORD` from `/blakpath/production/runtime`
   if those keys exist.

Confirm the user has no access keys and is not attached to `AmazonSESFullAccess`.
Do not print key material.

## API endpoint

The cluster that runs BlakPath uses
`infra/aws/eks-api-endpoint.example.yaml`: private API access, no public
CIDR of `0.0.0.0/0` or `::/0`. Reach a private API through Tailscale. A public
endpoint, if one must remain, lists admin or CI CIDRs only.

Apply that contract with `UpdateClusterConfig`. On `yumait-prod` this affects
every team. The target is the dedicated cluster in
`docs/adr/0001-dedicated-cluster.md`. Coordinate before changing the shared
cluster.

## Rotate the runtime secret

Do this after the cross-namespace sync returns AccessDenied and the blakpath
ExternalSecret is Ready. Update the secret in Secrets Manager, wait for the
refresh, then restart web and worker. Do not write the new values into tickets,
shell history, or this repo.

1. Database password, then `DATABASE_URL`.
2. Cache auth token, then `REDIS_URL`.
3. `BETTER_AUTH_SECRET` (at least 32 characters). Existing sessions end.
4. Revoke the old PaperBoy key, then store the new `PAPERBOY_API_KEY`.
5. `EMAIL_WEBHOOK_SECRET` (at least 16 characters).
6. Remove `SMTP_USER` and `SMTP_PASSWORD`.
7. `ENCRYPTION_MASTER_KEY` only when no ciphertext depends on it.
   `decryptField` uses the current key alone, so replacing it makes stored
   fields unreadable. Before production records, replace it with a new
   base64 32-byte value and bump `ENCRYPTION_KEY_VERSION`. After records
   exist, leave it until wrapped data keys can be rewrapped.

Record who rotated, when, and which keys. Do not record the values.

## Data services

- RDS Postgres with point-in-time recovery. Proxy in front for failover.
- ElastiCache Redis TLS. Ephemeral only: queues, rate limits, schedulers.
- S3 evidence + quarantine buckets: block public access, enforce TLS + CMK,
  versioning on, AWS Backup coverage. MinIO exists for local dev only.
- S3 audit-anchor bucket: created with Object Lock compliance retention
  (see `infra/aws/audit-anchor-bucket.example.yaml`). The worker may put and
  read objects. It must not be granted delete or governance bypass. Web tasks
  do not use this bucket.
- SES in ap-southeast-2 publishes permanent bounces and complaints to an SNS
  topic. Set `EMAIL_SNS_TOPIC_ARN` to that topic. Delivery target is
  `POST /api/email/events`. The app checks the SNS signature and the pinned
  topic, and accepts `EMAIL_WEBHOOK_SECRET` only as the
  `x-email-webhook-secret` header. SNS cannot set that header; a forwarder
  (API Gateway or Lambda) must add it from Secrets Manager. Transient bounces
  are not suppressed. A platform operator clears a suppression with
  `POST /api/admin/email-suppressions` (step-up, audited).
- PaperBoy (`https://paperboy.yumait.au`) is the production mail sender:
  create an API key there, store it as `PAPERBOY_API_KEY` in
  `blakpath-eks-runtime`, and keep `PAPERBOY_URL` in the ConfigMap. Sender
  contract: `POST {PAPERBOY_URL}/api/v1/emails` with
  `Authorization: Bearer <key>` and a JSON body of
  `{from, to, subject, text}`. Wiring the sender to PaperBoy is tracked work;
  until then mail flows through the SES API under the workload role.

## Database roles

The application role must not own the tables. As the RDS master, run
`infra/postgres/audit-roles.sql` once: create `blakpath_migrator` and
`blakpath_app`, then reassign existing objects to the migrator. Store their
connection URLs in the two secrets above. `infra/k8s/jobs/migrate.yaml` reads
`DATABASE_MIGRATION_URL` from `blakpath-migrator` and refuses to run in
production when that role matches `DATABASE_URL`. After migrate, the app role
has `SELECT` and `INSERT` only on `audit_events` and
`audit_integrity_checkpoints`.

## Audit anchor signing key (KMS)

Daily chain-head anchors are signed with a separate asymmetric KMS key from
the CoA key. Private key material never leaves KMS.

1. Create the key: RSA_2048 (or ECC_NIST_P256), usage SIGN_VERIFY, alias
   `alias/blakpath-audit-anchor`, ap-southeast-2.
2. Grant the worker role `kms:Sign`, `kms:GetPublicKey` and `kms:DescribeKey`
   on that key. Do not grant `kms:Sign` to the web role.
3. Set `AUDIT_ANCHOR_SIGNING_KEY_ID` to the key ARN in the runtime secret.
4. Set `S3_BUCKET_AUDIT_ANCHORS` and `AUDIT_ANCHOR_OBJECT_LOCK=true` in the
   ConfigMap. Confirm the first day's objects exist before accepting
   production records.

## CoA signing key (KMS)

Certificates are sealed with an asymmetric KMS key and verified publicly
against its public key — private key material never leaves KMS. Payload version
2 also seals a salted hash of the holder name and the PDF SHA-256. Public
verification can check a name the verifier types; it never displays that name.
Version 1 seals continue to verify.

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
