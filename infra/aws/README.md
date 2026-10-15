# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` is the EKS Pod Identity split for web and
  worker. Trust is `pods.eks.amazonaws.com`, limited to namespace `blakpath`,
  service account `blakpath-web` or `blakpath-worker`, and the cluster name.
  The stack creates both associations. ClamAV and migrate have no role.
  Neither role has Secrets Manager permission or access keys. Tenant keys are
  used only with encryption-context purpose `field`, `platform`,
  `blind-index`, or `key_validation` (plus `key_health` for the web role's key
  check). The worker signs audit anchors with its own key and is denied
  `kms:Sign` on every other key. The worker can list and delete object
  versions of evidence and quarantine keys: retention must remove every version
  of a purged key, and `s3:DeleteObject` alone only writes a delete marker on a
  versioned bucket. The matching statement for a client's own key
  policy is in `docs/customer-held-keys.md`.
- `unused-access-analyzer.example.yaml` creates an account unused-access
  analyzer when one does not already exist. Review findings per role using
  `unused-access-review.md`. Do not treat a finding as permission to add an
  action.
- `eks-boundary.example.yaml` is the secret-sync and mail boundary. One role
  reads `/blakpath/production/*` from the `blakpath` namespace only. The shared
  External Secrets role is denied that folder and the app-secrets key. The web
  and worker roles may `ses:SendEmail` from the application address. No SMTP
  user and no access key.
- `eks-api-endpoint.example.yaml` keeps the Kubernetes API private. Public
  CIDRs must not be `0.0.0.0/0` or `::/0`.
- `operational-alerts.example.yaml` converts the application’s structured JSON
  `signal` fields into CloudWatch metrics and pages an existing on-call SNS topic.
  `key_health_state_change` is one of those signals.
  `clamav_signature_age` carries `ageHours` and pages when the maximum in an
  hour is greater than 48.
- `backup-plan.example.yaml` creates one CMK-encrypted backup vault, locks it
  in compliance mode, and backs up RDS plus the evidence and quarantine buckets.
  Failed, aborted and expired backup jobs page the same on-call topic.
- `data-tier.example.yaml` is the RDS Postgres and ElastiCache Redis stack:
  private subnets, customer managed keys, `rds.force_ssl=1`, Redis AUTH and
  `noeviction`. It does not create the RDS Proxy. Settings and the apply steps
  are in `docs/data-tier-capacity.md`. Deploy it only in `ap-southeast-2`.
- `origin-edge.example.yaml` requests the origin ACM certificate, a regional
  WAFv2 web ACL (managed IP reputation, common, known-bad-inputs and SQLi rule
  groups) and the Authenticated Origin Pull trust store. Copy its outputs into
  `infra/k8s/service-ingress.yaml`. The CA bundle is the zone certificate, not
  the shared Cloudflare origin-pull CA, and must not include a private key.
- `tenant-cmk/` is the per-tenant CMK an operator applies. It does not run
  itself. Client-account keys live in `infra/client-kms/`.
- `escrow-vault.example.yaml` is the optional key escrow vault. Deploy it only
  in a dedicated escrow account, never the workload account. Its RSA-4096 key
  only decrypts sealed escrow items, under dual control (officer A enables the
  key and reads packages; officer B decrypts). Packages sit in an Object Lock
  (compliance) bucket. Key and bucket policies deny the workload account and
  every principal outside the vault account; an Access Analyzer gives the
  evidence. See [`docs/key-escrow-runbook.md`](../../docs/key-escrow-runbook.md).
- `account-guardrails.example.yaml` is the account detective baseline for this
  Region: Security Hub (FSBP v1.0.0 and CIS AWS Foundations Benchmark v5.0.0),
  a Config recorder for every supported resource type, IAM Access Analyzer
  (external access and unused access), GuardDuty S3 and RDS protection, and a
  CloudTrail trail encrypted with `alias/blakpath-security-logs`, delivered to
  CloudWatch Logs, with S3 data events limited to the BlakPath evidence and
  quarantine buckets. The trail is multi-Region so calls outside
  `ap-southeast-2` are visible; the log bucket stays in this Region.
- `eks-guardrails.example.yaml` creates `alias/blakpath-eks-secrets` and the
  `/aws/eks/<cluster>/cluster` log group. It does not create a cluster.
  `eks-cluster-guardrails.json` is the control-plane setting to apply to the
  existing cluster: all five log types, deletion protection, and secrets
  envelope encryption with that CMK.

Network boundaries expected by these templates:

- public ingress terminates TLS at a WAF-protected load balancer;
- web pods run in private subnets and accept traffic only from that load balancer;
- worker pods have no inbound security-group rules;
- PostgreSQL, Redis and ClamAV accept traffic only from the web/worker groups that
  need them; database transport is `sslmode=verify-full` against the RDS global
  bundle baked into the image, and Redis uses TLS;
- S3, KMS, Secrets Manager, CloudWatch Logs and ECR use VPC endpoints so pod
  traffic does not require a public route;
- the quarantine and evidence buckets block public access, enforce TLS and a
  bucket-default customer-managed KMS key, and enable versioning and AWS
  Backup coverage. Objects for a tenant use that tenant's CMK with S3 Bucket
  Keys off. The example role allows tenant envelope calls for purpose `field`,
  `platform`, `blind-index`, and `key_validation`, and allows S3 to use a
  tenant CMK when `kms:ViaService` is `s3.ap-southeast-2.amazonaws.com`.
  Backup copies of tenant objects remain ciphertext under that tenant's CMK.
  Deleting the CMK makes those copies unreadable. A restored environment must
  have the client key grant again before the application can decrypt. Apply
  the template before expecting HeadObject to succeed against a real tenant key.

## Object lifecycle (`s3-lifecycle/`)

`s3-lifecycle/*.json` are `PutBucketLifecycleConfiguration` documents for the
two buckets. Apply each with the bucket's owning tooling (or
`aws s3api put-bucket-lifecycle-configuration --bucket <name>
--lifecycle-configuration file://infra/aws/s3-lifecycle/<file>.json`), then
confirm with `aws s3api get-bucket-lifecycle-configuration --bucket <name>`.
Applying replaces any existing rules on that bucket, so merge first if the
bucket already carries rules.

| Bucket     | Rule                            | Effect                                                                                                                                         |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| evidence   | `expire-exports`                | Objects tagged `blakpath-lifecycle=export` (every generated CSV export) expire 7 days after creation; their noncurrent versions 1 day later.   |
| evidence   | `expire-noncurrent-versions`    | Noncurrent versions of anything else expire after 30 days; expired delete markers are removed; incomplete multipart uploads abort after 1 day. |
| quarantine | `expire-abandoned-uploads`      | Anything left in quarantine 2 days (abandoned or never-scanned uploads) expires; noncurrent versions 1 day later; stale multipart aborts.      |
| quarantine | `remove-expired-delete-markers` | Cleans up the delete markers the rule above leaves behind.                                                                                     |

S3 lifecycle filters cannot wildcard (`*/exports/*`) because every key starts
with the organisation id, so exports are selected by an object tag the worker
sets at upload time (`src/lib/storage/lifecycle.ts`; a unit test pins the two
together). The export rule is a backstop: the worker's export maintenance sweep
normally purges every version of an expired export within
`EXPORT_SWEEP_INTERVAL_MS` and marks the request `expired`.

Reconcile the 30-day noncurrent window with AWS Backup before applying: backup
recovery points are independent copies, so expiring noncurrent versions does not
shorten backup retention, but it does bound how long an overwritten or deleted
evidence object can be recovered from the bucket itself. Keep it at or below the
retention period the privacy policy promises for deleted records.

The worker role needs `s3:PutObjectTagging`, `s3:AbortMultipartUpload`,
`s3:DeleteObject` and `s3:DeleteObjectVersion` on export keys (statement
`ExportLifecycle` in `workload-roles.example.yaml`); version listing is
already granted by `RetentionVersionList`. Exports stay SSE-KMS under the
tenant CMK, so multipart completion uses the existing `TenantObjectSse` grant.

## Release check

Run `pnpm release:check` inside the exact web and worker images before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the Pod Identity role through its default credential provider chain.

Nothing in this directory is applied by the application or by CI. An account
owner deploys it.

## Backup vault

`backup-plan.example.yaml` is the production backup control. Apply it only in
`ap-southeast-2`, after the retention numbers in `docs/offboarding.md` have been
accepted. The lock's cooling-off is 7 days. After that the lock is compliance
mode and cannot be removed or relaxed. Changing the vault name or CMK replaces
the vault. The previous vault is retained and keeps its name, so a replacement
needs a new vault name.

Retention encoded in the template:

- vault minimum 35 days, vault maximum 90 days;
- continuous point-in-time recovery, deleted after 35 days;
- daily snapshot at 03:00 `Australia/Sydney`, deleted after 90 days;
- no cold storage and no copy out of the vault.

The selection lists the RDS instance (or Aurora cluster), the evidence bucket
and the quarantine bucket. Quarantine stays in the plan: an upload can contain
personal information before scanning, and a restore of that bucket must not
promote or serve those objects. Redis is not a selection. It is ephemeral.

Before the stack is created:

- the vault CMK is a BlakPath customer-managed key in `ap-southeast-2`, passed
  as a key ARN rather than an alias;
- that key's policy allows `blakpath-backup-service` and `backup.amazonaws.com`
  `kms:DescribeKey`, `kms:Decrypt`, `kms:GenerateDataKey` and `kms:CreateGrant`
  (the service principal restricted with `kms:ViaService` of
  `backup.ap-southeast-2.amazonaws.com`);
- the RDS CMK and the bucket default CMK allow the same role to decrypt;
- evidence, certificate, export and quarantine objects are SSE-KMS under each
  tenant's own CMK (`organisation_keys`, often in the client's account), not a
  platform key. Each tenant key policy must also allow `blakpath-backup-service`
  `kms:Decrypt`. Without it AWS Backup reports the job as successful and skips
  that tenant's objects. Check object counts per tenant prefix after the first
  job, not only the job status;
- both buckets have versioning on, public access blocked, and TLS required;
- the RDS instance is not already in another continuous backup plan;
- the on-call SNS topic already allows `cloudwatch.amazonaws.com` to publish.

Open decision before apply: AWS Backup re-encrypts S3 recovery points under
the vault CMK (independent encryption), not the tenant CMK. Deleting a tenant
key then does not shred that tenant's objects in S3 recovery points until they
expire (up to 90 days). That conflicts with the crypto-shredding statement in
`docs/customer-held-keys.md` section 5. RDS recovery points keep tenant fields
sealed in-app, so they are not affected.

Recovery points show up in `list-protected-resources` only after the first
successful job. Alarm response, the test fire, and that check are in
`docs/operations-runbook.md`. Deleting the CloudFormation stack retains the
vault; compliance mode would reject deleting it while recovery points exist.
## Account guardrails

Deploy `account-guardrails.example.yaml` in `ap-southeast-2` only. Pass the
existing evidence bucket, quarantine bucket, bucket default CMK
(`alias/blakpath-prod-evidence`), and the Config
service-linked role ARN
`arn:aws:iam::ACCOUNT_ID:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`.
Create that role first if it is missing. Do not create a second one.

One Config recorder, one delivery channel, one GuardDuty detector and one
Security Hub subscription can exist in the Region. One trail should record
management events. If any of those already exist, import them into the stack
or change them to match this template. A second management trail doubles cost
and leaves the old trail without KMS and CloudWatch delivery.

`EnableS3MalwareProtection` defaults to `false`. Set it to `true` only as a
second scanner signal. ClamAV still decides whether an object is promoted.
GuardDuty tags (`GuardDutyMalwareScanStatus`) must not promote or reject
evidence. The plans tag objects and add a validation object in each bucket.
The malware role can decrypt only the bucket default CMK. Tenant objects are
SSE-KMS under each tenant's own CMK (`organisation_keys`, often in the client
account), so GuardDuty cannot read them and reports them as not scanned. Do not
widen the role to `kms:Decrypt` on `*` or add it to tenant key policies to make
those scans pass; that would give another principal plaintext under a
customer-held key. ClamAV is the only scanner for tenant objects.

If `OnCallTopicArn` is set, allow `events.amazonaws.com` to `sns:Publish` to
that topic. The first Security Hub import can notify for every open critical.
Triage those by hand; do not auto-close them. Findings are account posture.
They do not score, rank or decide Aboriginality.

After deploy, confirm:

- the Config recorder is recording and `AllSupported` is true, including
  global resource types in this Region only;
- the trail is logging, `KMSKeyId` is the key behind `alias/blakpath-security-logs`,
  CloudWatch Logs delivery is on, and data events cover both BlakPath buckets;
- Security Hub shows FSBP v1.0.0 and CIS v5.0.0.

If trail delivery fails with `AccessControlListNotSupported`, remove the
`s3:x-amz-acl` condition from `AWSCloudTrailWrite` and update the stack. The
bucket uses BucketOwnerEnforced.

### Security Hub baseline record

Wait until both standards show a score, then write this outside the account
(the release record, not this repository):

| Field                          | Value                                             |
| ------------------------------ | ------------------------------------------------- |
| Date (UTC)                     |                                                   |
| Region                         | ap-southeast-2                                    |
| Standards                      | FSBP v1.0.0, CIS AWS Foundations Benchmark v5.0.0 |
| Security score                 |                                                   |
| Critical / High / Medium / Low |                                                   |
| Config recorder                | recording, all supported types                    |

Triage every critical before calling the baseline done:

| Finding ID | Title | Resource | Decision                       | Owner | Notes |
| ---------- | ----- | -------- | ------------------------------ | ----- | ----- |
|            |       |          | fix, accept, or false positive |       |       |

A decision needs a person and a written reason. Accepting a finding does not
change how BlakPath records identity.

## EKS guardrails

Deploy `eks-guardrails.example.yaml` with the existing cluster name. Then,
against that cluster only:

```bash
aws eks update-cluster-config \
  --region ap-southeast-2 \
  --name "$CLUSTER_NAME" \
  --deletion-protection \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'

aws eks associate-encryption-config \
  --region ap-southeast-2 \
  --cluster-name "$CLUSTER_NAME" \
  --encryption-config "[{\"resources\":[\"secrets\"],\"provider\":{\"keyArn\":\"$SECRETS_KEY_ARN\"}}]"
```

`$SECRETS_KEY_ARN` is the `EksSecretsKeyArn` output (`alias/blakpath-eks-secrets`
is the alias). Kubernetes 1.28 and later already envelope-encrypts API data
with an AWS-owned key. This associates the BlakPath CMK. Association is
irreversible. Deleting the key leaves the cluster unrecoverable. If the API
rejects the association because a CMK is already set, keep the existing key
and do not create another cluster. After a successful association, rewrite
existing Kubernetes secrets so new data keys use the CMK.

`eks-cluster-guardrails.json` is that desired state. It is not a cluster
create document.
