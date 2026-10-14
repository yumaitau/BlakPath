# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL` (role `blakpath_app`), `REDIS_URL`, `BETTER_AUTH_SECRET`,
   `EMAIL_WEBHOOK_SECRET`, `ORIGIN_VERIFY_SECRET`,
   `AUDIT_ANCHOR_SIGNING_KEY_ID`. `EMAIL_SNS_TOPIC_ARN` is not a secret; it
   lives in the ConfigMap. Set `PLATFORM_KMS_KEY_ARN` (platform CMK, not a
   secret) in the config. Do not set `ENCRYPTION_LOCAL_KEY`, `KMS_ENDPOINT`,
   `SMTP_USER`, `SMTP_PASSWORD` or `PAPERBOY_*`: there is no mail credential
   (see [Email](#email)). `ENCRYPTION_MASTER_KEY` is optional and
   only reads version-1 ciphertext. Create a separate secret at
   `/blakpath/production/migrator` with only `DATABASE_MIGRATION_URL` (role
   `blakpath_migrator`). Do not put the migrator URL in the runtime secret.
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
   promoting. It rejects static S3 credentials, standing SMTP credentials,
   `PAPERBOY_*` and `PILOT_BOOTSTRAP_TOKEN`, and requires the SES sender
   config. SDK uses the workload role. Do not put
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
  `alias/blakpath-prod-evidence` is the bucket default for both S3 buckets.
  Objects written for a tenant use that tenant's CMK, with S3 Bucket Keys
  off, so HeadObject shows the tenant key ARN. RDS uses its provisioned key.
  No AWS-managed default keys in the secret path. The key policy keeps
  account-root IAM delegation so the dedicated role's IAM allow works. Do not
  grant the shared External Secrets role on that key.
- ElastiCache runs with transit and at-rest encryption. Redis holds
  ephemeral state only. Queue payloads are identifiers, never tenant field
  contents.
- Set `OPERATOR_ONCALL_EMAIL` on the worker. Key-health state changes email
  that address and emit `key_health_state_change` for the on-call alarm.
  Tenant CMKs are registered per organisation; see
  `docs/client-key-onboarding.md`.

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
4. `EMAIL_WEBHOOK_SECRET` (at least 16 characters). Update the forwarder too.
5. Remove `SMTP_USER`, `SMTP_PASSWORD` and any `PAPERBOY_*` key.
6. `ENCRYPTION_MASTER_KEY` only when no ciphertext depends on it.
   `decryptField` uses the current key alone, so replacing it makes stored
   fields unreadable. Before production records, replace it with a new
   base64 32-byte value and bump `ENCRYPTION_KEY_VERSION`. After records
   exist, leave it until wrapped data keys can be rewrapped.

Record who rotated, when, and which keys. Do not record the values.

## Data services

- RDS Postgres with point-in-time recovery. Proxy in front for failover.
- ElastiCache Redis TLS. Ephemeral only: queues, rate limits, schedulers.
- S3 evidence + quarantine buckets: block public access, enforce TLS,
  versioning on, AWS Backup coverage. The bucket default CMK is
  `alias/blakpath-prod-evidence`. Per-object SSE-KMS uses the tenant CMK.
  Certificates and exports are objects in the evidence bucket. MinIO exists
  for local dev only and does not send SSE headers.
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
- Email: see [Email](#email).

## Email

One production sender: the **SES v2 API in ap-southeast-2 under the
workload role** ([ADR 0090](adr/0090-production-email-sender.md)). No SMTP
relay, no static mail credentials, no third-party mail service. Locally and in
CI mail goes to Mailpit over unauthenticated SMTP (`EMAIL_TRANSPORT=smtp`, the
default), which the app refuses in production.

Runtime config (ConfigMap): `EMAIL_TRANSPORT=ses`,
`SES_CONFIGURATION_SET=blakpath-production`,
`SMTP_FROM=BlakPath <no-reply@blakpath.yumait.au>`,
`EMAIL_SNS_TOPIC_ARN`. Secret: `EMAIL_WEBHOOK_SECRET`. `pnpm release:check` fails if any of these are missing
or if `SMTP_USER`, `SMTP_PASSWORD`, `PAPERBOY_URL` or `PAPERBOY_API_KEY` is set.

Set-up, once per environment, from
[`infra/aws/ses-sending.example.yaml`](../infra/aws/ses-sending.example.yaml):

1. Subdomain identity `blakpath.yumait.au` with Easy DKIM (RSA 2048) and custom
   MAIL FROM `bounce.blakpath.yumait.au` (MX to
   `feedback-smtp.ap-southeast-2.amazonses.com`, SPF
   `v=spf1 include:amazonses.com -all`). The parent `yumait.au` identity stays
   as is; SES uses the most specific verified identity.
2. DMARC TXT at `_dmarc.blakpath.yumait.au`: start at `p=quarantine` with
   strict DKIM alignment (`adkim=s`), relaxed SPF alignment (`aspf=r`) and an
   aggregate `rua` mailbox; move to `p=reject` once reports are clean. If the `rua` mailbox is on another domain, that domain must publish
   the DMARC external-report authorisation record.
3. Configuration set `blakpath-production` (TLS required, account-level
   suppression for bounces and complaints) with an event destination for
   `BOUNCE` and `COMPLAINT` to a KMS-encrypted SNS topic. The topic key policy
   must allow `ses.amazonaws.com`.
4. HTTPS subscription from that topic (`blakpath-email-events`, equal to
   `EMAIL_SNS_TOPIC_ARN`) to the forwarder in front of
   `https://blakpath.yumait.au/api/email/events`. The forwarder adds the
   `x-email-webhook-secret` header; never put the secret in a URL, the app
   rejects it. The app checks the SNS signature and topic and confirms the
   subscription itself. Only permanent bounces and complaints suppress an
   address; transient bounces are ignored.
5. Attach the template's `ses:SendEmail` policy (scoped to the identity and the
   configuration set) to the web and worker Pod Identity roles. Web sends auth
   mail synchronously; the worker sends invitations and notifications.
6. Remove the identity that shows `FAILED` in the SES console once confirmed
   unused, and delete any leftover SES SMTP IAM user.

Verify before accepting records (staging first, then production):

- Send a staff invitation and a password reset to an external mailbox (for
  example Gmail). In "Show original", the `Authentication-Results` header must
  show `dkim=pass` (`header.d=blakpath.yumait.au`), `spf=pass`
  (`smtp.mailfrom=bounce.blakpath.yumait.au`) and `dmarc=pass`.
- Send to `bounce@simulator.amazonses.com` and
  `complaint@simulator.amazonses.com` with the configuration set (for example
  invite those addresses in staging). Confirm `email suppressions recorded` in
  the web logs with `count: 1`, a new `email_suppressions` row and an
  `email.suppressed` audit event for each.

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
   Re-establish the client CMK grant before expecting tenant plaintext. A
   restored backup does not recreate a deleted key.
3. Download clean evidence through normal authorised path (quarantine blocks
   bypass). Run audit-verify, expect clean chain. Confirm a tenant whose grant
   is missing fails closed and that another tenant still reads.
4. Record date, operator, source, target, elapsed RTO, verification result
   outside restored environment.

## Alarms

Audit divergence, oldest quarantined-evidence age
(`blakpath-oldest-quarantined-age`, 30 minutes), malware-scan dead-letter depth
(`blakpath-malware-scan-dlq`), dead-letter email/export/retention/webhook jobs,
backup failures, sustained 5xx / readiness failures. See
`infra/aws/operational-alerts.example.yaml` for signal mapping. The evidence
sweep redrives stuck scans; the age alarm means that redrive is not draining.
