# EKS runbook — BlakPath on Elastic Kubernetes Service

Region: `ap-southeast-2` for everything (cluster, RDS, ElastiCache, S3,
SES, Secrets Manager, ECR, CloudWatch). No cross-region data movement.

## Layout

Manifests live in `infra/k8s`.

- `base` is environment-neutral. It has no account id, no bucket name and no
  key ARN. Do not apply it on its own.
- `overlays/staging` renders namespace `blakpath-staging`, host
  `staging.blakpath.yumait.au`, Secrets Manager paths
  `/blakpath/staging/runtime` and `/blakpath/staging/migrator`, SES
  configuration set `blakpath-staging` and External Secrets role
  `blakpath-staging-external-secrets`.
- `overlays/production` renders namespace `blakpath`, host
  `blakpath.yumait.au`, Secrets Manager paths `/blakpath/production/runtime`
  and `/blakpath/production/migrator`, SES configuration set
  `blakpath-production` and External Secrets role `blakpath-external-secrets`.
- `overlays/<environment>/release-check` is the pre-deploy gate.
  `overlays/<environment>/jobs` renders the catalogue seed Job.
  `base/jobs/migrate.yaml` is rendered per release by `scripts/eks-deploy.sh`.
  None of these are part of the main overlay.
- `cluster` is cluster-scoped (network policy controller) and has no
  environment.

The ECR registry, image tag, account id, buckets and bucket default KMS key
are tokens. They are filled at deploy time from private CD config and are
never committed:

| Token                                                       | Deploy variable           |
| ----------------------------------------------------------- | ------------------------- |
| `__ECR_REGISTRY__`, `__IMAGE_TAG__`                         | `IMAGE`, `WORKER_IMAGE`   |
| `__AWS_ACCOUNT_ID__`                                        | `AWS_ACCOUNT_ID`          |
| `__PRODUCTION_S3_BUCKET_EVIDENCE__`, `__STAGING_…`          | `S3_BUCKET_EVIDENCE`      |
| `__PRODUCTION_S3_BUCKET_QUARANTINE__`, `__STAGING_…`        | `S3_BUCKET_QUARANTINE`    |
| `__PRODUCTION_S3_BUCKET_AUDIT_ANCHORS__`, `__STAGING_…`     | `S3_BUCKET_AUDIT_ANCHORS` |
| `__PRODUCTION_S3_KMS_KEY_ID__`, `__STAGING_S3_KMS_KEY_ID__` | `S3_KMS_KEY_ID`           |

The staging tokens are `__STAGING_S3_BUCKET_EVIDENCE__`,
`__STAGING_S3_BUCKET_QUARANTINE__`, `__STAGING_S3_BUCKET_AUDIT_ANCHORS__` and
`__STAGING_S3_KMS_KEY_ID__`. `scripts/eks-deploy.sh` pins the images to the
release digests, fills the tokens for the chosen `ENVIRONMENT`, and refuses
a missing value or any token left over. The Deploy workflow reads the values
from variables on the GitHub `production` environment.
`node scripts/check-k8s-overlays.mjs --source` rejects a committed account
id, key id, or ARN with a real account field.

## Deploy

1. Build web + worker images from the same commit, push to ECR
   ap-southeast-2, and record both digests. The migrate Job uses the **app**
   image digest, not a separate tag and not the worker image.
2. Create Secrets Manager JSON at `/blakpath/<environment>/runtime`
   (`/blakpath/production/runtime` or `/blakpath/staging/runtime`) with
   `DATABASE_URL` (role `blakpath_app`), `REDIS_URL`, `BETTER_AUTH_SECRET`,
   `EMAIL_WEBHOOK_SECRET`, `ORIGIN_VERIFY_SECRET`,
   `AUDIT_ANCHOR_SIGNING_KEY_ID`. `EMAIL_SNS_TOPIC_ARN` is not a secret; it
   lives in the ConfigMap. Set `PLATFORM_KMS_KEY_ARN` (platform CMK, not a
   secret) in the config. Do not set `ENCRYPTION_LOCAL_KEY`, `KMS_ENDPOINT`,
   `SMTP_USER`, `SMTP_PASSWORD` or `PAPERBOY_*`: there is no mail credential
   (see [Email](#email)). `ENCRYPTION_MASTER_KEY` is optional and
   only reads version-1 ciphertext; nothing writes it. Drop it once the
   encryption backfill has completed for every organisation. Create a separate secret at
   `/blakpath/<environment>/migrator` with only `DATABASE_MIGRATION_URL` (role
   `blakpath_migrator`). Do not put the migrator URL in the runtime secret.
   Apply `infra/postgres/audit-roles.sql` once as the RDS master before the
   first migrate (see [Database roles](#database-roles)).
   The runtime secret also needs `COA_SIGNING_KEY_ID` (KMS key ARN or alias in
   ap-southeast-2). Do not set `COA_SIGNING_LOCAL_KEY_PEM`.
3. In `infra/aws/eks-boundary.example.yaml`, replace `OIDC_ID` with the cluster
   OIDC issuer id. Deploy that stack in ap-southeast-2 after step 4: it
   attaches the mail-send policy to the `blakpath-web` and `blakpath-worker`
   roles. `PlatformEsoRoleName` is the shared External Secrets role, never
   `blakpath-external-secrets`, `blakpath-web` or `blakpath-worker`.
4. Install the EKS Pod Identity agent add-on. Deploy
   `infra/aws/workload-roles.example.yaml` with the cluster name, bucket ARNs,
   evidence CMK, CoA signing CMK, audit anchor bucket and key, and platform
   CMK. It creates roles `blakpath-web` and `blakpath-worker` and associations
   for service accounts `blakpath-web` and `blakpath-worker` only. ClamAV and
   the migrate/seed jobs have no AWS role and mount no API token.
5. Install External Secrets Operator and a ClusterSecretStore named
   `aws-secretsmanager` (the migrator ExternalSecret uses it). The runtime
   secret syncs through the namespaced SecretStore `blakpath-secrets` and
   its own IRSA role (see [Secrets and keys](#secrets-and-keys)).
6. Roll out with the Deploy workflow or `scripts/eks-deploy.sh`. Set
   `ENVIRONMENT` (`production`, the default, or `staging`) and the deploy
   variables in [Layout](#layout). Pass `IMAGE` and `WORKER_IMAGE` as
   `@sha256` digests and `RELEASE_ID` as the git sha. Before the first
   apply, replace the `ACCOUNT_ID`, `CERT_ID`, `TRUST_STORE_ID` and
   `WEB_ACL_ID` placeholders in the ingress annotations (see
   [Edge and origin](#edge-and-origin)). The script applies namespace,
   service accounts, config and ExternalSecrets, then runs three steps in
   order, each only after the previous one succeeds:
   1. the release-check Job (`node release-check.cjs`) in the candidate web
      and worker images;
   2. the per-release migrate Job (`blakpath-migrate-<git sha>`,
      `ttlSecondsAfterFinished` 86400) from the app digest;
   3. the web and worker Deployments at those digests.
      A failed gate or migration does not roll the workloads. `DRY_RUN=1`
      renders without applying. Applying `infra/k8s/overlays/<environment>`
      alone skips the gate and the migration. Complete the edge section below first.
      Rolling the app before the origin-verify header is live makes production
      requests return 403. The namespace enforces Pod Security `restricted`;
      every pod runs non-root with a read-only root filesystem. Enable the
      network policy controller first (see [Network policy](#network-policy)).
7. Moving from the shared `blakpath` service account: deploy step 4 before
   step 6, so the new associations exist when web and worker restart. Then
   delete the pod identity association for `blakpath/blakpath` and retire
   `blakpath-eks-runtime`. Confirm the ClamAV pods have no AWS credential
   environment variables.
8. The release-check Job in step 6 is the gate. `pnpm release:check` runs the
   same checks where the source tree exists. It rejects static S3 credentials,
   standing SMTP credentials, `PAPERBOY_*`, `PILOT_BOOTSTRAP_TOKEN` and
   `COA_SIGNING_LOCAL_KEY_PEM`, and requires the SES sender config. SDK uses
   the EKS Pod Identity role. Do not put `PILOT_BOOTSTRAP_TOKEN` in the
   runtime secret.
9. After the first release, apply the seed job from
   `infra/k8s/overlays/<environment>/jobs`, then
   `infra/k8s/base/jobs/invite-admin.yaml` with the first administrator's
   email (see [Hand-applied jobs](#hand-applied-jobs)).
   The job emails an organisation-administrator invitation and does not create
   a password. That person enrols a passkey or authenticator before the
   organisation tools open.
10. Verify `/api/ready` behind ALB, sign in, select org, confirm audit chain clean.
    Liveness and startup use `/api/live`. A public request to `/api/health` is
    refused; read that report from inside the VPC. From a pod in another
    namespace, confirm it cannot open BlakPath ports.

## Hand-applied jobs

The seed Job renders from the jobs overlay. Fill the image tokens with the
worker image you are releasing:

```sh
kubectl kustomize infra/k8s/overlays/production/jobs \
  | sed \
    -e "s|__ECR_REGISTRY__|${ECR_REGISTRY}|g" \
    -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
  | kubectl apply -f -
```

`ECR_REGISTRY` is `<account-id>.dkr.ecr.ap-southeast-2.amazonaws.com`. Use
`infra/k8s/overlays/staging/jobs` for staging. Re-applying a finished Job
fails until the old Job is deleted, which is why Jobs stay out of the main
overlay.

`infra/k8s/base/jobs/invite-admin.yaml` and
`infra/k8s/base/jobs/provision-organisation.yaml` take names and email
addresses, so they are filled in by hand and never committed filled. In a
copy outside the repo, replace every `REPLACE_*` value,
`blakpath/worker:unset` with the worker image, and, for staging,
`namespace: blakpath` with `namespace: blakpath-staging`. Then
`kubectl apply -f` the copy.

## Staging

Staging has its own namespace, secret folder, host, buckets, bucket key, SES
configuration set, SNS topic and External Secrets role. A staging render
names no production secret path, host, role, topic or configuration set.
Evidence journeys that need object storage and cannot run on local MinIO
are covered here (`docs/e2e-journeys.md`). Council onboarding runs
`tests/e2e/team-isolation.spec.ts` against this environment
(`docs/council-onboarding.md`).

Before the first apply, create these for staging. Do not point staging at
production resources.

- Secrets Manager `/blakpath/staging/runtime` and `/blakpath/staging/migrator`.
- IRSA role `blakpath-staging-external-secrets` for
  `system:serviceaccount:blakpath-staging:blakpath-external-secrets`, reading
  only `/blakpath/staging/*`.
- Evidence, quarantine and audit-anchor buckets, and the staging bucket key.
- SES configuration set `blakpath-staging` and SNS topic
  `blakpath-staging-email-events`.
- DNS name `staging.blakpath.yumait.au`, with its own certificate, trust
  store and WAF ACL for the ingress annotations.
- Pod Identity associations for `blakpath-web` and `blakpath-worker` in
  namespace `blakpath-staging`. `infra/aws/workload-roles.example.yaml` and
  `infra/aws/eks-boundary.example.yaml` describe production only.

## Network policy

The namespace is default-deny (`infra/k8s/base/network-policy.yaml`, plus the
ClamAV policies in `clamav.yaml` and `clamav-mirror.yaml`). Nothing is
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
4. Apply through `scripts/eks-deploy.sh` (it renders
   `infra/k8s/overlays/<environment>`), and `kubectl kustomize infra/k8s/cluster`
   only as a merge, per step 1.
   The one-shot jobs carry their own pod labels (`blakpath-migrate` for the
   per-release migrate Job, `blakpath-job` for seed, `blakpath-admin-job` for
   invite-admin, `blakpath-release-check` for the `scripts/eks-deploy.sh`
   gate). The policies ship in `infra/k8s/base`, so on a first deploy they apply
   after the gate and migration; from the second release on they cover both.

Allows, and nothing else:

- ALB to web TCP 3000 (service port is 3000, same as the container). The
  target-group health check uses the same port.
- Web and worker to ClamAV TCP 3310. No other pod.
- ClamAV scanner to the in-namespace mirror on TCP 8080 only.
- The mirror to public TCP 80 and 443 (`database.clamav.net`). Private,
  CGNAT and link-local ranges are excepted.
- DNS to the Auto Mode CoreDNS address, NodeLocal DNSCache
  (`169.254.20.10`), and `kube-system` on port 53.
- Web, worker and the invite-admin job to the Pod Identity agent
  `169.254.170.23:80`. IMDS stays closed. ClamAV, the mirror and
  migrate/seed have no AWS role and no Pod Identity path.
- Web, by DNS name, to RDS (5432), ElastiCache TLS (6379), S3, KMS, Secrets
  Manager, STS, the SES v2 API, the SNS subscription confirm host and Entra
  (443). No SMTP and no open internet.
- Worker to those same private ports, plus public TCP 443 outside the VPC.
  Tenant webhooks are HTTPS and are not a fixed host list, so this is the
  only general egress, and only the worker has it. Private webhook targets
  are denied.
- Migrate, seed and release-check jobs to DNS and Postgres only. The
  release-check gate validates env and opens no socket today.
- Invite-admin job to DNS, Pod Identity, Postgres, and KMS, STS and the
  SES v2 API by name.

Check after apply:

- A debug pod outside `blakpath` cannot connect to web:3000 or ClamAV:3310.
- Web `/api/ready` behind the ALB is 200 when Postgres, Redis and S3 are up.
- A worker job (scan or email) completes.
- The mirror pod becomes Ready and a scanner `freshclam` run pulls from it.
- A worker webhook to a public HTTPS host succeeds. The same URL from web
  or ClamAV does not. A webhook aimed at a VPC address does not.

Add the OTLP collector hostname to `blakpath-web-egress` before tracing is
required. Export failure does not fail readiness.

Image references in `infra/k8s/overlays/<environment>` are
`__ECR_REGISTRY__` / `__IMAGE_TAG__` tokens. A release replaces them with
digests. Do not `kubectl apply` `infra/k8s/base/jobs/migrate.yaml` by hand.

## Rollback

Migrations are forward-only. Roll back code by redeploying the previous image
digest. Do not write a down migration. Point-in-time recovery is only for
data corruption, and never into the live namespace.

Release N-1 must still run on schema N. That is the expand/contract rule in
`docs/database-migrations.md`: a release may add tables, nullable columns,
concurrent indexes and `NOT VALID` foreign keys. It may not drop, rename or
tighten columns the previous release still uses. The contract (drop the old
shape) waits until N-1 is gone.

1. If the migrate Job failed, stop. `scripts/eks-deploy.sh` has not changed
   Deployments. Transactional DDL rolled back. Fix the migration forward and
   release again. A lock wait aborts in under five seconds
   (`lock_timeout` 4s) instead of stalling the rollout.
2. If the new code is up and misbehaving but the data is intact, point the
   web and worker Deployments back at the previous digests. Do not run a
   migrate Job for that rollback. Schema stays at N. The previous digest
   still works because N was expand-only. Confirm `/api/ready`, sign-in and
   one staff flow.
3. If a migration committed bad or destroyed data, stop writes, take a fresh
   recovery point, and restore into a new isolated namespace using the
   restore drill below. Promote that namespace only after sign-in, tenant
   records, evidence authorisation and the audit chain verify. Do not restore
   over the live database.

Staging still needs one human rehearsal of steps 1 and 2 against the staging
cluster. A disposable-Postgres rehearsal of the same steps is recorded in
`docs/migration-drills/` when it has been run. The cluster rehearsal is not
something this repository can apply by itself.

## Edge and origin

Do this before the deployment above accepts production traffic. The listener
manifest is `infra/k8s/base/service-ingress.yaml`. The example stack is
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

## Rollouts and the database connection budget

The namespace label `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` tells the
AWS Load Balancer Controller to inject a target-health readiness gate. Install
that controller before the first deploy. Without it the label does nothing and
the ALB can still route to a pod that is not registered. Both the production
and staging namespace overlays set the label.

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
replica stays Pending.

Pool sizes, HPA max and the 225-connection floor are in
`src/db/connection-budget.ts`, in the section below. Do not raise
`maxReplicas` without changing that module.

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
5. RDS `DatabaseConnections` stays at or under the connection budget (157, 70%
   of 225) while the HPA is at max and a rollout is in progress.

## Secrets and keys

- Dedicated folder: every BlakPath production secret lives under
  `/blakpath/production/` in Secrets Manager (staging: `/blakpath/staging/`).
  The app reads one synced `blakpath-runtime` Secret. The store is
  namespace-local (`infra/k8s/base/secretstore.yaml`). Its role
  `blakpath-external-secrets` can read that folder only, and only when the
  IRSA subject is `system:serviceaccount:blakpath:blakpath-external-secrets`.
  The production overlay sets that role ARN on the service account, with
  `__AWS_ACCOUNT_ID__` for the account.
- The shared External Secrets role is denied `GetSecretValue` on
  `secret:/blakpath/production/*` and `kms:Decrypt` on
  `alias/blakpath-app-secrets`. Do not point BlakPath at the cluster-wide
  store.
- After the deny is in place, an ExternalSecret for
  `/blakpath/production/runtime` outside namespace `blakpath` must fail with
  AccessDenied. Delete that check object. Do not print Secret data.
- Customer keys everywhere: `alias/blakpath-app-secrets` encrypts the
  Secrets Manager folder and is the account default EBS key.
  `alias/blakpath-prod-evidence` is the bucket default for both S3 buckets.
  Objects written for a tenant use that tenant's CMK, with S3 Bucket Keys
  off, so HeadObject shows the tenant key ARN. `alias/blakpath-rds` covers
  RDS storage and Performance Insights; `alias/blakpath-elasticache` covers
  Redis at rest (both from `infra/aws/data-tier.example.yaml`). These are
  platform keys for the volume; tenant fields inside the database are still
  sealed with the tenant key. No AWS-managed default keys in the secret or
  data path. The key policy keeps
  account-root IAM delegation so the dedicated role's IAM allow works. Do not
  grant the shared External Secrets role on that key.
- ElastiCache runs with transit encryption, an AUTH token, and at-rest
  encryption. Redis holds
  ephemeral state only. Queue payloads are identifiers, never tenant field
  contents.
- Set `OPERATOR_ONCALL_EMAIL` on the worker. Key-health state changes email
  that address and emit `key_health_state_change` for the on-call alarm.
  Tenant CMKs are registered per organisation; see
  `docs/client-key-onboarding.md`.

## Mail credentials

Production mail uses `ses:SendEmail` on the `blakpath-web` and
`blakpath-worker` roles, limited to
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
6. `ENCRYPTION_MASTER_KEY` is not rotated. It only reads version-1
   ciphertext, and replacing it makes those values unreadable. Run the
   encryption backfill for every organisation, confirm
   `PLAINTEXT_RESIDUE_SQL` reports 0, then remove the key.

Record who rotated, when, and which keys. Do not record the values.

## Data services

- Source: `infra/aws/data-tier.example.yaml` (RDS Postgres and ElastiCache
  Redis, private subnets, customer managed keys, `rds.force_ssl=1`, 21-day
  backups, Redis AUTH and `noeviction`). It does not create the RDS Proxy.
  Settings and apply steps: `docs/data-tier-capacity.md`. Apply it in
  `ap-southeast-2`, then deploy the namespace through the CD pipeline (#57).
  `/api/ready` is the post-deploy check.
- RDS Postgres with point-in-time recovery. `infra/aws/backup-plan.example.yaml`
  keeps 35-day continuous point-in-time recovery and a 90-day daily snapshot in
  a compliance-locked vault. Do not also enrol the instance in another
  continuous backup plan. RDS Proxy in front for failover.
  Two roles: `blakpath_migrator` (owner, migrate Job only) and
  `blakpath_app` (runtime DML). See `infra/postgres/audit-roles.sql`.
  Clients connect to the proxy hostname, not an IP and not a CNAME that is
  absent from the certificate.
- TLS is `sslmode=verify-full` for web, worker and the migrate Job. The app and
  worker images bake
  `certs/rds-global-bundle.pem` (the public Amazon RDS global bundle) and set
  `ssl: { ca, rejectUnauthorized: true }`. The release gate rejects
  `require`, `verify-ca`, and any missing mode. `require` is not verification:
  postgres.js then skips certificate verification.
- Session timeouts are startup parameters, not `SET` (a PostgreSQL `SET` pins
  an RDS Proxy session). App connections use `statement_timeout=60s`,
  `lock_timeout=10s`, `idle_in_transaction_session_timeout=30s`. The migrate Job
  uses `lock_timeout=4s` and a 10 minute statement cap on its own single
  connection (startup parameters, then `SET` by the runner).
- Named prepared statements are off (`prepare: false`). RDS Proxy can multiplex
  the extended query protocol, but SQL `PREPARE`/`EXECUTE` still pins, and
  older proxies pinned named protocol statements. The client never issues those.
- ElastiCache Redis TLS and AUTH token, two nodes, Multi-AZ failover,
  `maxmemory-policy noeviction`, snapshot retention 0. Ephemeral only:
  queues, rate limits, schedulers. Not in the backup plan.
- S3 evidence + quarantine buckets: block public access, enforce TLS,
  versioning on. Both buckets are in that backup plan. The bucket default CMK is
  `alias/blakpath-prod-evidence`. Per-object SSE-KMS uses the tenant CMK.
  Certificates and exports are objects in the evidence bucket. MinIO exists
  for local dev only and does not send SSE headers.
- S3 lifecycle: apply `infra/aws/s3-lifecycle/{evidence,quarantine}-bucket.json`
  (exports 7 days, quarantine 2 days, noncurrent versions 30 days, stale
  multipart 1 day) and verify with `get-bucket-lifecycle-configuration`. The
  worker Pod Identity role also needs the `ExportLifecycle` statement from
  `infra/aws/workload-roles.example.yaml` (tagging, multipart abort, version
  delete on `*/exports/*`) before this release deploys. See
  `infra/aws/README.md`.
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
  `POST /api/admin/email-suppressions` (step-up, audited). Organisation
  administrators see suppressed members and invitees on Settings → People and
  can clear one for their own tenant (step-up, audited as
  `email.suppression_cleared`).
- Set `EMAIL_SEND_RATE_PER_SECOND` (ConfigMap) to the live SES sending quota.
  The worker paces the Email and Notification queues beneath it across all
  replicas and re-queues sender-throttled sends without spending a retry.
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
connection URLs in the two secrets above. `infra/k8s/base/jobs/migrate.yaml` reads
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

## Database connection budget

Checked in `src/db/connection-budget.ts` and `tests/unit/connection-budget.test.ts`.
The instance must provide at least 225 `max_connections`. That is the RDS
default for 2 GiB (`LEAST({DBInstanceClassMemory/9531392}, 5000)`), so
`db.t4g.small` or larger. Do not use a smaller class without lowering the
pools and updating the budget test. Leave `max_connections` at the default on
that size or larger.

| Process                            | Replicas at HPA max | Pool | Connections          |
| ---------------------------------- | ------------------- | ---- | -------------------- |
| Web (`blakpath-app`)               | 4                   | 10   | 40                   |
| Worker (`blakpath-worker`, no HPA) | 2                   | 33   | 66                   |
| Migration job                      | 1                   | 1    | 1                    |
| **Steady total**                   |                     |      | **107** (48% of 225) |

Rollout surge is web `maxSurge: 1` (5 × 10) and worker `maxSurge: 1` (3 × 33)
plus the migration connection: 150, which is 67% of 225. Both stay at or under
70% (157). The worker pool is 11 queues × concurrency 3, so each in-flight job
can hold a connection.

`DATABASE_URL` in the runtime secret must include `sslmode=verify-full`.
`DATABASE_POOL_MAX=10` is in the ConfigMap. The worker deployment sets
`BLAKPATH_PROCESS=worker` and `DATABASE_WORKER_POOL_MAX=33`.

After the proxy is in service, under load, confirm CloudWatch
`DatabaseConnectionsCurrentlySessionPinned` stays near zero. This repository
does not create the proxy or run that load. A non-zero metric means some
session state is pinning (a `SET`, SQL `PREPARE`, a temporary table, or a
session advisory lock). Transaction-scoped advisory locks
(`pg_advisory_xact_lock`) do not pin.

## CoA signing key (KMS)

Certificates are sealed with an asymmetric KMS key and verified publicly
against its public key — private key material never leaves KMS. Payload version
2 also seals a salted hash of the holder name and the PDF SHA-256. Public
verification can check a name the verifier types; it never displays that name.
Version 1 seals continue to verify.

1. Create the key: RSA_2048 (or ECC_NIST_P256), usage SIGN_VERIFY, alias
   `alias/blakpath-coa-signing`, ap-southeast-2. Staging uses its own key,
   alias `alias/blakpath-staging-coa-signing`.
2. Grant only the web role `kms:Sign` and `kms:GetPublicKey` on that key
   (`CoaSigningKeyArn` in `infra/aws/workload-roles.example.yaml`). The worker
   role denies `kms:Sign` on every key except the audit anchor key. Public
   verification needs no KMS access at all, so `kms:Verify` is not granted.
   Action-by-action review: `infra/aws/unused-access-review.md`.
3. Set `COA_SIGNING_KEY_ID` to the alias (`alias/blakpath-coa-signing`) or the
   key ARN in the runtime secret.
4. Every seal stores the resolved key ARN KMS reports it signed with (never
   the alias), and the first seal by a key stores that key's public half
   (SPKI + SHA-256 fingerprint) in `signing_keys`. `/verify` checks seals
   offline against that stored public key — zero KMS calls per request.

Rotation. KMS does not rotate asymmetric keys in place, so rotation is a new
key plus an alias retarget:

1. Create a new SIGN_VERIFY key (same spec) and grant the web role
   `kms:Sign` and `kms:GetPublicKey` on it.
2. Retarget the alias: `aws kms update-alias --alias-name
alias/blakpath-coa-signing --target-key-id <new-key-id>` (or, if
   `COA_SIGNING_KEY_ID` holds an ARN, point it at the new ARN and restart).
   The next seal records the new ARN and its public key automatically.
3. Earlier certificates keep verifying from their stored public keys, so the
   old key can then be disabled and scheduled for deletion once the backfill
   below reports nothing outstanding. Do not delete a key whose public half
   is not in `signing_keys`.

Seals made before `signing_keys` existed carry the alias/env value and have no
stored public key, so `/verify` shows them "Not verified" until backfilled.
While every old key is still enabled, run
`pnpm certificates:backfill-signing-keys` (dry run), then with `--apply`.
If the alias was already retargeted, append the previous key ARN as an extra
candidate. Each seal is re-verified against a candidate key before its
`signing_key_id` is rewritten to that ARN; nothing is re-signed.

Local development and CI use `COA_SIGNING_LOCAL_KEY_PEM`, which the app
refuses in production.

## Restore drill (EKS variant)

1. Restore RDS and both buckets from a recovery point in the locked BlakPath
   vault into an isolated namespace with a separate secret copy. Never restore
   into `blakpath` or `blakpath-staging`. Quarantine objects stay unscanned.
   Re-apply audited deletions newer than the recovery point
   (`docs/offboarding.md`). `docs/operations-runbook.md` has the
   `list-protected-resources` check.
2. Run migrations, sign in as seeded admin, confirm records present.
   Re-establish the client CMK grant before expecting tenant plaintext. A
   restored backup does not recreate a deleted key.
3. Download clean evidence through normal authorised path (quarantine blocks
   bypass). Run audit-verify, expect clean chain. Confirm a tenant whose grant
   is missing fails closed and that another tenant still reads.
4. Record date, operator, source, target, elapsed RTO, verification result
   outside restored environment.

## Cluster guardrails

Deploy `infra/aws/eks-guardrails.example.yaml` in `ap-southeast-2` before the
namespace holds production records. It creates `alias/blakpath-eks-secrets` and
the log group `/aws/eks/<cluster>/cluster` (365-day retention). It does not
create a cluster.

The live cluster then has to match `infra/aws/eks-cluster-guardrails.json`:
control-plane logs `api`, `audit`, `authenticator`, `controllerManager` and
`scheduler`; deletion protection on; secrets envelope encryption with that CMK.
Commands and the irreversible-key warning are in `infra/aws/README.md`.

On `yumait-prod` these changes affect every team. Coordinate before
changing the shared cluster; the target is the dedicated cluster in
`docs/adr/0001-dedicated-cluster.md`.

## ClamAV

`infra/k8s/base/clamav.yaml` runs two non-root scanner pods. Each has a signature
volume and a readiness PING, so the Service stays empty until clamd answers and
a node drain keeps one pod Ready. `infra/k8s/base/clamav-mirror.yaml` is the only
pod allowed to download signatures from the public mirrors.

The `blakpath-clamav` ServiceAccount must not get an IRSA annotation or a Pod
Identity association. The scanner network policy does not allow link-local
metadata. Set the node IMDS hop limit to 1 as well, and enable network policy
enforcement (#60) or the metadata block is not active.

The signature volume is ReadWriteOnce. Schedule the two scanner pods in the
same availability zone as their volumes, on two different nodes.

## Alarms

Audit divergence, oldest quarantined-evidence age
(`blakpath-oldest-quarantined-age`, 30 minutes), malware-scan dead-letter depth
(`blakpath-malware-scan-dlq`), dead-letter email/export/retention/webhook jobs,
backup failures (`blakpath-backup-job-failed`), sustained 5xx / readiness
failures, ClamAV signature age above 48 hours. See
`infra/aws/operational-alerts.example.yaml` for application log signals and
`infra/aws/backup-plan.example.yaml` for the backup-job alarm.
The evidence sweep redrives stuck scans; the age alarm means that redrive is
not draining.
