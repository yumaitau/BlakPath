# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` is the EKS Pod Identity split for web and
  worker. Trust is `pods.eks.amazonaws.com`. ClamAV and migrate have no role.
  Neither role has Secrets Manager permission or access keys. Runtime secrets
  are synced by External Secrets Operator under its own platform role.
- `unused-access-analyzer.example.yaml` creates an account unused-access
  analyzer when one does not already exist. Review findings per role using
  `unused-access-review.md`. Do not treat a finding as permission to add an
  action.
- `operational-alerts.example.yaml` converts the application’s structured JSON
  `signal` fields into CloudWatch metrics and pages an existing on-call SNS topic.

Network boundaries expected by these templates:

- public ingress terminates TLS at a WAF-protected load balancer;
- web pods run in private subnets and accept traffic only from that load balancer;
- worker pods have no inbound security-group rules;
- PostgreSQL, Redis and ClamAV accept traffic only from the web/worker groups that
  need them; database and Redis transports use TLS;
- S3, KMS, Secrets Manager, CloudWatch Logs and ECR use VPC endpoints so pod
  traffic does not require a public route;
- the quarantine and evidence buckets block public access, enforce TLS and the
  named customer-managed KMS key, and enable versioning and AWS Backup coverage.

Run `pnpm release:check` inside the exact web and worker images before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the Pod Identity role through its default credential provider chain.
