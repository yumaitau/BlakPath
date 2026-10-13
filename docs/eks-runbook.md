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
6. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.

## Rollouts and the database connection budget

The namespace label `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` tells the
AWS Load Balancer Controller to inject a target-health readiness gate. Install
that controller before the first deploy. Without it the label does nothing and
the ALB can still route to a pod that is not registered.

Web pods sleep 15 seconds in `preStop`. That matches the Ingress attribute
`deregistration_delay.timeout_seconds=15`, so in-flight requests finish before
SIGTERM. `terminationGracePeriodSeconds` on web is 40. The kubelet counts the
sleep against that period, then the process still has 25 seconds to exit.

Workers do not sleep in `preStop`. SIGTERM starts their job drain
(`WORKER_SHUTDOWN_GRACE_SECONDS`, 25 seconds). Their grace period is 30 seconds.

Web, worker and ClamAV use `topologySpreadConstraints` on
`topology.kubernetes.io/zone` and `kubernetes.io/hostname` with `maxSkew: 1`
and `whenUnsatisfiable: DoNotSchedule`. The node group must already span at
least two AZs, with a schedulable node in each, or the second web or worker
replica stays Pending. ClamAV is one replica; the same rules apply if it is
scaled past one.

Connection budget, from `src/lib/fleet-capacity.ts`:

- RDS floor: 1 GiB class (`db.t4g.micro`), default `max_connections` 112.
  Formula: `LEAST({DBInstanceClassMemory/9531392}, 5000)`. A larger class is
  inside this budget. A parameter group that lowers `max_connections` is not.
- Cap: peak connections must stay under 80% of `max_connections` (89.6 on the
  floor).
- Pool: `DATABASE_POOL_MAX` 10 per web or worker process. The ConfigMap holds
  the value. Web and worker pin that key with an explicit `env` entry, which
  overrides `envFrom`, so `/blakpath/production/runtime` must not be relied on
  to set the pool. Do not add `DATABASE_POOL_MAX` to that secret.
- Web HPA: min 2, max 4, `maxSurge` 1, `maxUnavailable` 0.
- Workers: 2 replicas, `maxSurge` 1, `maxUnavailable` 0. No worker HPA.
- Migrate job: 1 connection.

Rollout peak is `(4 + 1 + 2 + 1) × 10 + 1 = 81`, under 80% of 112. Steady
state at HPA max, with no rollout, is `(4 + 2) × 10 = 60`. Do not raise
`maxReplicas` without changing the module. The unit test computes the new
maximum. Do not run the seed job during a rollout while web is at
`maxReplicas`: seed takes a full pool and is outside the 81-connection peak.

### Check a rollout

Applying these manifests, and the load test below, is a human step. This
repository does not apply them to a cluster.

On a cluster whose nodes already span two AZs:

1. Send load through the ALB at `https://blakpath.yumait.au/api/ready`.
2. Roll web (`kubectl rollout restart deployment/blakpath-app -n blakpath`)
   and drain one node.
3. ALB `HTTPCode_Target_5XX_Count` and `HTTPCode_ELB_5XX_Count` stay at 0
   for that window.
4. `kubectl get pods -n blakpath -o wide` shows web and worker pods in at
   least two zones.
5. RDS `DatabaseConnections` stays under 90 while the HPA is at max and a
   rollout is in progress.

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
