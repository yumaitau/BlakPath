# Production readiness and recovery

BlakPath must not accept production records until this checklist is completed by
the deployment owner. The application is designed for `ap-southeast-2`; its
dependencies, backups, monitoring and operational staff must remain in that
region.

## Release gate

The gate checks the process environment and prints failing keys, never values.
Beyond the checks below it requires an ap-southeast-2 KMS key ARN or alias for CoA signing
(`COA_SIGNING_KEY_ID`) and rejects `COA_SIGNING_LOCAL_KEY_PEM`.
`OTEL_EXPORTER_OTLP_ENDPOINT` may be unset (tracing stays off); when set it must
be HTTPS and non-local. Web and worker run the same rules at boot when
`NODE_ENV=production`, except the `DATABASE_MIGRATION_URL` checks: runtime pods
never mount the migrator secret.

- [ ] Roll out with `scripts/eks-deploy.sh <image-tag>` or the Deploy workflow.
      That runs `node release-check.cjs` in the candidate web and worker images
      against the production ConfigMap, runtime Secret and migrator URL, and
      applies workloads only after the Job exits 0. Attach the key-only output to
      the release record. `pnpm release:check` is the same gate on a machine that
      has the source tree.
      The check fails when `PILOT_BOOTSTRAP_TOKEN` is set. Leave that variable
      unset. The web and worker processes also refuse to boot if it is set.
      The gate requires `PLATFORM_KMS_KEY_ARN` and rejects `ENCRYPTION_LOCAL_KEY`
      and `KMS_ENDPOINT`. `ENCRYPTION_MASTER_KEY` is not required.
- [ ] Use managed PostgreSQL, object storage and Redis in `ap-southeast-2`.
- [ ] Inject runtime secrets from managed secret storage. Do not place real
      values in images, source control, CI logs or long-lived environment files.
- [ ] Apply `infra/aws/eks-boundary.example.yaml` and the workload trust policy
      so `/blakpath/production/*` syncs only in the `blakpath` namespace.
      Confirm a sync of that key from any other namespace is AccessDenied,
      then rotate the runtime secret (`docs/eks-runbook.md`).
- [ ] Retire IAM user `blakpath-ses-smtp`: no access keys and no
      `AmazonSESFullAccess`. Production mail uses the workload role.
- [ ] Keep the EKS API endpoint private, or limit public CIDRs to admin and CI
      networks. `0.0.0.0/0` and `::/0` fail the release. See
      `docs/adr/0001-dedicated-cluster.md`.
- [ ] Terminate TLS at the origin listener (HTTP redirects to HTTPS), set the
      Cloudflare zone to Full (strict), verify the zone-level Authenticated
      Origin Pull certificate, attach the regional WAF web ACL, and set
      `ORIGIN_VERIFY_SECRET` in both the runtime secret and the Cloudflare
      request-header transform. Keep the security headers in `next.config.ts`
      enabled. Client addresses come from `clientIp` (`src/lib/http/client-ip.ts`).
- [ ] Configure database point-in-time recovery and versioned, encrypted object
      storage backups. Redis is not a durable source of record.
- [ ] Run a documented restore drill into an isolated environment. Confirm a
      tenant can sign in, their records are present, objects can be read only after
      the normal authorisation checks, and `audit-verify` reports a clean chain.
      Re-establish each client key grant in the restored environment before
      expecting tenant plaintext. A backup copy stays ciphertext under that
      CMK ([`key-lifecycle.md`](key-lifecycle.md)).
- [ ] Set an owner and escalation path for failed readiness checks, scanner
      availability, exhausted jobs, audit-chain divergence and backup failures.
- [ ] Record counsel and pilot-council review of the client trust pack
      ([`customer-held-keys.md`](customer-held-keys.md)) and one auditor
      walkthrough of its verification steps against a staging tenant. Include the
      encryption-keys page, its health-check endpoint and the escrow vault in the
      penetration-test scope.
- [ ] Deploy the workload-role and operational-alarm controls under `infra/aws/`
      (or reviewed equivalents) and complete an on-call test notification.
- [ ] After ClamAV is applied, record 72 hours that include at least three
      signature updates and zero `blakpath-clamav` container restarts.
- [ ] Deploy the SES sender (`infra/aws/ses-sending.example.yaml`, ADR 0090).
      An invitation and a password reset must reach an external mailbox with
      `dkim=pass spf=pass dmarc=pass`, and simulator bounce/complaint events
      must create suppressions in staging (`docs/eks-runbook.md#email`).
- [ ] Narrow the RFC1918 blocks in `infra/k8s/network-policy.yaml` to the live
      VPC database, Redis and endpoint subnets. Webhook delivery stays off
      in-cluster and link-local addresses. Rotate any webhook endpoint whose
      stored secret is not envelope ciphertext.
- [ ] Enable the EKS Auto Mode network policy controller and apply
      `infra/k8s/network-policy.yaml`. A pod outside `blakpath` must not reach
      BlakPath ports. Steps and the allow list are in `docs/eks-runbook.md`.

## Signals and response

`/api/live` is process liveness (Kubernetes liveness and startup probes, and
the container `HEALTHCHECK`). It does not touch PostgreSQL, Redis, storage or
ClamAV, so a dependency blip marks pods NotReady instead of restarting them.
`/api/ready` is the readiness probe and the ALB target health check. It returns
503 when PostgreSQL, Redis or evidence storage is down, with `timeoutSeconds: 3`
and `failureThreshold: 3`. ClamAV is visible but a missing scanner does not
remove the web service from rotation, and that probe is capped below one second.
Dependency results are cached for five seconds on each pod. Uploads remain
quarantined until scanning succeeds.

`/api/health` is the detailed operator report (service, region, coarse checks).
The public edge returns 403 for that path, and the app refuses any request that
arrived through the load balancer or Cloudflare. Operators read it from inside
the VPC (port-forward the web Service, or curl the pod). The ALB health check
stays on `/api/ready` and does not use the detailed report.

Alert on:

- any `audit chain verification FAILED` worker event;
- evidence scans that exhaust their retry policy, a malware-scan dead-letter
  depth above zero, or quarantined evidence older than 30 minutes
  (`evidence_quarantine_backlog`);
- failed or dead-lettered email, export, retention and webhook jobs;
- failed backup jobs or restore-drill failures;
- sustained 5xx/readiness failures;
- ClamAV signature age above 48 hours.

The stable log signals are `queue_job_exhausted`, `audit_integrity_failure`,
`clamav_unavailable`, `clamav_signature_age`, `evidence_quarantine_backlog`
and `readiness_dependency_down`. Response steps are in
[`operations-runbook.md`](operations-runbook.md). Signal records contain only
opaque ids and coarse dependency states; job payloads and applicant data are not
included.

The response runbook must preserve records and evidence. Never bypass quarantine
or edit the audit chain to restore availability.

## Restore drill record

Record the date, operator, source backup, restore target, elapsed time, audit
verification result and any follow-up actions. Keep that record outside the
restored environment so it remains available during an incident.

Run `pnpm test:restore` for the non-production reference drill. It populates an
isolated source through the full live-service browser journey, takes logical
PostgreSQL and bucket backups, restores them into a separate target, verifies
evidence checksums and the tenant audit chain, then signs in and downloads the
clean evidence through the normal authorisation path. The JSON result under
`tmp/restore-drills/` contains the measured RTO and no personal data or secrets.
