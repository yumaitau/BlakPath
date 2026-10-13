# Production readiness and recovery

BlakPath must not accept production records until this checklist is completed by
the deployment owner. The application is designed for `ap-southeast-2`; its
dependencies, backups, monitoring and operational staff must remain in that
region.

## Release gate

- [ ] Run `pnpm release:check` in the exact production web and worker runtime
      environments; attach the successful key-only output to the release record.
      The gate requires `PLATFORM_KMS_KEY_ARN` and rejects `ENCRYPTION_LOCAL_KEY`
      and `KMS_ENDPOINT`. `ENCRYPTION_MASTER_KEY` is not required.
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

`/api/health` reports process and dependency health. `/api/ready` is for load
balancers and returns 503 when PostgreSQL, Redis or evidence storage is down.
ClamAV is visible in both reports but does not remove the whole web service from
rotation: uploads remain quarantined until scanning succeeds.

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
