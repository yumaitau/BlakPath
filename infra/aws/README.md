# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` separates web, worker and ECS execution roles.
  The application roles have no Secrets Manager permission and no access keys;
  the execution role can inject one named runtime secret into the tasks.
- `operational-alerts.example.yaml` converts the application’s structured JSON
  `signal` fields into CloudWatch metrics and pages an existing on-call SNS topic.

Network boundaries expected by these templates:

- public ingress terminates TLS at a WAF-protected load balancer;
- web tasks run in private subnets and accept traffic only from that load balancer;
- worker tasks have no inbound security-group rules;
- PostgreSQL, Redis and ClamAV accept traffic only from the web/worker groups that
  need them; database and Redis transports use TLS;
- S3, KMS, Secrets Manager, CloudWatch Logs and ECR use VPC endpoints so task
  traffic does not require a public route;
- the quarantine and evidence buckets block public access, enforce TLS and the
  named customer-managed KMS key, and enable versioning and AWS Backup coverage.

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
`s3:DeleteObjectVersion` and `s3:ListBucketVersions` on export keys (see
`workload-roles.example.yaml`).

## Release check

Run `pnpm release:check` inside the exact web and worker task definitions before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the task role through its default credential provider chain.
