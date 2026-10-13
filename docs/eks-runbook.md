# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`,
   `EMAIL_WEBHOOK_SECRET` (32+ random characters). Do not add `SMTP_USER`,
   `SMTP_PASSWORD` or `PAPERBOY_*`: there is no mail credential, and the
   release gate fails if any are present (see [Email](#email)).
3. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
4. Set image tags and host, apply: `kubectl kustomize infra/k8s | kubectl apply -f -`
   after replacing `ACCOUNT_ID`, `TAG`, host, role ARNs, WAF ACL ARN.
5. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 and SMTP credentials and requires the SES
   sender config; the SDK uses the workload role chain.
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
- Email: see [Email](#email).

## Email

One production sender: the **SES v2 API in ap-southeast-2 under the
workload role** ([ADR 0090](adr/0090-production-email-sender.md)). No SMTP
relay, no static mail credentials, no third-party mail service. Locally and in
CI mail goes to Mailpit over unauthenticated SMTP (`EMAIL_TRANSPORT=smtp`, the
default), which the app refuses in production.

Runtime config (ConfigMap): `EMAIL_TRANSPORT=ses`,
`SES_CONFIGURATION_SET=blakpath-production`,
`SMTP_FROM=BlakPath <no-reply@blakpath.yumait.au>`. Secret:
`EMAIL_WEBHOOK_SECRET`. `pnpm release:check` fails if any of these are missing
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
4. HTTPS subscription from that topic to
   `https://blakpath.yumait.au/api/email/events?secret=<EMAIL_WEBHOOK_SECRET>`
   (SNS cannot send headers). The app confirms the subscription itself, only for
   genuine `sns.*.amazonaws.com` URLs. Only permanent bounces and complaints
   suppress an address; transient bounces are ignored.
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
