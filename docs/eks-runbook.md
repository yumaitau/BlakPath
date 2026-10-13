# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Deploy

1. Build web + worker images, push to ECR ap-southeast-2 with immutable tags.
2. Create Secrets Manager JSON at `/blakpath/production/runtime` with
   `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_MASTER_KEY`,
   `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_WEBHOOK_SECRET`.
3. Install External Secrets Operator + ClusterSecretStore `blakpath` (IRSA).
4. Set image tags and host, apply: `kubectl kustomize infra/k8s | kubectl apply -f -`
   after replacing `ACCOUNT_ID`, `TAG`, host, role ARNs, WAF ACL ARN.
5. Run `pnpm release:check` inside the exact web and worker images before
   promoting. It rejects static S3 credentials; SDK uses IRSA task role chain.
6. Enable network policy, then apply the manifests. See below.
7. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.
   From a pod in another namespace, confirm it cannot open BlakPath ports.

## Network policy

The namespace is default-deny (`infra/k8s/network-policy.yaml`). Nothing is
enforced until the controller is on. This cluster is shared, so do not set
the NodeClass `networkPolicy` field to `DefaultDeny` — that drops every pod
on the node pool. Leave it `DefaultAllow`. BlakPath deny comes from the
namespace policies. `networkPolicyEventLogs: Enabled` on that NodeClass is
optional.

1. Merge the controller flag. Do not replace the ConfigMap if it already
   holds other keys:

   ```bash
   kubectl -n kube-system patch configmap amazon-vpc-cni --type merge \
     -p '{"data":{"enable-network-policy-controller":"true"}}'
   ```

   The desired key is also in `infra/k8s/cluster/enable-network-policy.yaml`.

2. Confirm the cluster service CIDR. CoreDNS on Auto Mode is the `.10`
   address of that CIDR (`172.20.0.10` or `10.100.0.10` in the policy). If
   this cluster uses another CIDR, change `blakpath-dns` before apply.
3. Narrow the worker and job RFC1918 blocks to the RDS, ElastiCache and VPC
   endpoint subnet CIDRs. The checked-in ranges are wide enough for a first
   apply in `ap-southeast-2` and are not the final boundary.
4. Apply: `kubectl kustomize infra/k8s | kubectl apply -f -`
   and `kubectl kustomize infra/k8s/cluster` only as a merge, per step 1.

Allows, and nothing else:

- ALB to web TCP 3000 (service port is 3000, same as the container).
- Web and worker to ClamAV TCP 3310. No other pod.
- DNS to the Auto Mode CoreDNS address, and to `kube-system` on port 53.
- Web and worker to the Pod Identity agent `169.254.170.23:80`. IMDS stays
  closed.
- Web, by DNS name, to RDS, ElastiCache, S3, KMS, Secrets Manager, STS, SES,
  the SNS subscription confirm host, PaperBoy and Entra. No open internet.
- Worker to those same private ports, plus public TCP 443 and 587 outside
  the VPC. Tenant webhooks are HTTPS and are not a fixed host list, so this
  is the only general egress, and only the worker has it. Private webhook
  targets are denied.
- ClamAV to `database.clamav.net` and `current.cvd.clamav.net` on TCP 443.
- Migrate and seed jobs to DNS, Pod Identity and Postgres only.

Check after apply:

- A debug pod outside `blakpath` cannot connect to web:3000 or ClamAV:3310.
- Web `/api/ready` behind the ALB is 200 when Postgres, Redis and S3 are up.
- A worker job (scan or email) completes.
- A worker webhook to a public HTTPS host succeeds. The same URL from web
  or ClamAV does not. A webhook aimed at a VPC address does not.

Add the OTLP collector hostname to `blakpath-web-egress` before tracing is
required. Export failure does not fail readiness.

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
- SES in ap-southeast-2 with SNS bounce/complaint topic wired to
  `POST /api/email/events` (shared-secret gated, persisted suppressions).
- PaperBoy (`https://paperboy.yumait.au`) is the production mail sender:
  create an API key there, store it as `PAPERBOY_API_KEY` in
  `blakpath-eks-runtime`, and keep `PAPERBOY_URL` in the ConfigMap. Sender
  contract: `POST {PAPERBOY_URL}/api/v1/emails` with
  `Authorization: Bearer <key>` and a JSON body of
  `{from, to, subject, text}`. Wiring the sender to PaperBoy is tracked work;
  until then mail flows through the SES API under the workload role.

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
