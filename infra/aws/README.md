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

Run `pnpm release:check` inside the exact web and worker images before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the Pod Identity role through its default credential provider chain.
