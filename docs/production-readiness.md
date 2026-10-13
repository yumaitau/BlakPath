# Production readiness and recovery

BlakPath must not accept production records until this checklist is completed by
the deployment owner. The application is designed for `ap-southeast-2`; its
dependencies, backups, monitoring and operational staff must remain in that
region.

## Release gate

- [ ] Run `pnpm release:check` in the exact production web and worker runtime
      environments; attach the successful key-only output to the release record.
- [ ] Use managed PostgreSQL, object storage and Redis in `ap-southeast-2`.
- [ ] Inject runtime secrets from managed secret storage. Do not place real
      values in images, source control, CI logs or long-lived environment files.
- [ ] Terminate TLS at the edge, forward only trusted proxy headers and keep
      the security headers in `next.config.ts` enabled.
- [ ] Configure database point-in-time recovery and versioned, encrypted object
      storage backups. Redis is not a durable source of record.
- [ ] Run a documented restore drill into an isolated environment. Confirm a
      tenant can sign in, their records are present, objects can be read only after
      the normal authorisation checks, and `audit-verify` reports a clean chain.
- [ ] Set an owner and escalation path for failed readiness checks, scanner
      availability, exhausted jobs, audit-chain divergence and backup failures.
- [ ] Deploy the workload-role and operational-alarm controls under `infra/aws/`
      (or reviewed equivalents) and complete an on-call test notification.

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
- evidence scans that exhaust their retry policy or remain quarantined beyond
  the agreed handling target;
- failed or dead-lettered email, export, retention and webhook jobs;
- failed backup jobs or restore-drill failures;
- sustained 5xx/readiness failures.

The stable log signals are `queue_job_exhausted`, `audit_integrity_failure`,
`clamav_unavailable` and `readiness_dependency_down`. Response steps are in
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
