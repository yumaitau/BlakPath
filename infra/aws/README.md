# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` separates web, worker and ECS execution roles.
  The application roles have no Secrets Manager permission and no access keys;
  the execution role can inject one named runtime secret into the tasks.
- `operational-alerts.example.yaml` converts the application’s structured JSON
  `signal` fields into CloudWatch metrics and pages an existing on-call SNS topic.
- `backup-plan.example.yaml` creates one CMK-encrypted backup vault, locks it
  in compliance mode, and backs up RDS plus the evidence and quarantine buckets.
  Failed, aborted and expired backup jobs page the same on-call topic.

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

Run `pnpm release:check` inside the exact web and worker task definitions before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the task role through its default credential provider chain.

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
- the RDS CMK and the evidence-bucket CMK allow the same role to decrypt;
- both buckets have versioning on, public access blocked, and TLS required;
- the RDS instance is not already in another continuous backup plan;
- the on-call SNS topic already allows `cloudwatch.amazonaws.com` to publish.

Recovery points show up in `list-protected-resources` only after the first
successful job. Alarm response, the test fire, and that check are in
`docs/operations-runbook.md`. Deleting the CloudFormation stack retains the
vault; compliance mode would reject deleting it while recovery points exist.
