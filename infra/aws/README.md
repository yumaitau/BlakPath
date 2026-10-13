# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` separates web, worker and ECS execution roles.
  The application roles have no Secrets Manager permission and no access keys;
  the execution role can inject one named runtime secret into the tasks.
  The worker role can list and delete object versions. Retention must remove
  every version of a purged key. `s3:DeleteObject` alone only writes a delete
  marker on a versioned bucket.
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

Run `pnpm release:check` inside the exact web and worker task definitions before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the task role through its default credential provider chain.
