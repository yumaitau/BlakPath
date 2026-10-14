# Operational alert runbook

All production logs are structured JSON and must remain in `ap-southeast-2`.
Alert routes are configured by `infra/aws/operational-alerts.example.yaml`.
Never paste applicant data, evidence content, bearer links or secrets into an
incident ticket.

## `queue_job_exhausted`

1. Identify the queue and opaque job id from the log event. Do not inspect or
   export job payloads into third-party systems.
2. Check the named dependency and the immediately preceding retry logs.
3. For `malware-scan`, leave the object quarantined. Restore scanner/storage
   service, then retry the existing job; never mark evidence clean manually.
4. For email/webhook/export, confirm whether the side effect happened before
   retrying. Processors are designed to be idempotent, but the operator must
   verify the external service response. A webhook marked `destination not allowed`
   or `endpoint secret unavailable` will not succeed on retry: correct the
   endpoint URL, or rotate the signing secret from the management API. The
   secret is shown once at creation and once at rotation. Do not copy it into
   the ticket.
5. Record the remediation and confirm the queue’s failed count returns to its
   expected baseline.

## `audit_integrity_failure`

1. Treat this as a security incident. Preserve database snapshots and relevant
   logs; do not edit, delete or “repair” audit rows.
2. Restrict administrative changes. `chain` is `tenant` or `platform`. A
   platform failure has a null organisation id; a tenant failure carries an
   opaque organisation id. Do not treat the platform chain as a tenant.
3. Compare the last trusted checkpoint with a restored backup in an isolated
   account and determine the first divergent event.
4. Escalate to the security owner and affected organisation under the incident
   communications plan. Resume normal operation only with documented approval.

## `clamav_unavailable`

1. Confirm ClamAV task health, signatures, memory and network reachability.
2. Keep uploads enabled only if the quarantine backlog remains within capacity;
   no unscanned object may be promoted or downloaded.
3. Restore the scanner and watch BullMQ retries drain. Page if two consecutive
   five-minute periods report the signal.

## `clamav_signature_age`

The worker logs this about every 15 minutes with `ageHours`. The alarm fires
when that value stays above 48.

1. Check the private mirror pod `blakpath-clamav-mirror` is Ready and that
   freshclam is still writing `/var/lib/clamav`. The scanner pods do not
   download from the public mirrors.
2. Do not restart the scanner to "force" an update unless freshclam is stuck.
   A reload with `ConcurrentDatabaseReload no` already blocks new scans on that
   pod; the other replica keeps serving. A restart drops a Ready endpoint.
3. Leave infected and unscanned objects in quarantine. Stale signatures are not
   a reason to mark evidence clean.
4. Confirm the next `clamav_signature_age` event is at or under 48 hours before
   closing the page.

## `readiness_dependency_down`

1. The load balancer should already have removed the affected web task because
   `/api/ready` returns 503. Liveness is `/api/live`, so the pod goes NotReady
   and is not restarted.
2. Check the coarse `database`, `redis` and `storage` statuses in the same event,
   then use the managed service’s own telemetry. Connection strings never belong
   in logs or tickets. Read `/api/health` from inside the VPC; the public edge
   refuses that report.
3. Restore the dependency, confirm `/api/live` remained healthy and `/api/ready`
   returns 200, then confirm the alarm returns to OK. Cached readiness can lag
   the recovery by about five seconds.

## Backup or restore failure

Stop the drill or recovery, preserve its target, and do not promote a partial
restore. Confirm the source recovery point is immutable, open an incident, and
repeat into a new isolated target after correcting the fault. A restore is usable
only after sign-in, tenant records, evidence authorisation and every audit chain
have been verified. Re-establish the client key grant before reading tenant
ciphertext. If the key was deleted, AWS Backup copies of that ciphertext are not
readable ([`key-lifecycle.md`](key-lifecycle.md)).

## Tenant key unavailable

1. Staff see a lock, not a generic 500. Public forms and verify pages say the
   encryption key is unavailable. They do not say the link or certificate is
   missing.
2. That tenant's jobs are delayed, not failed. Do not drain them by marking
   them complete, and do not copy plaintext out by another path.
3. If the client disabled the key or removed the grant, wait for them to
   restore it. The next health probe (within the data-key cache TTL) sets an
   `unavailable` row back to `active` and resumes paused jobs. `disabled` and
   `pending_deletion` stay off until an operator changes the status.
4. Other tenants keep running. A probe network error does not pause them.

## Vulnerability reports

Do not report a suspected vulnerability in a public issue, pull request,
discussion or this runbook. Do not paste personal information, evidence or
secrets into an operational ticket. Follow [`SECURITY.md`](../SECURITY.md).
