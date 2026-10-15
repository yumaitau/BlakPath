# Operational alert runbook

All production logs are structured JSON and must remain in `ap-southeast-2`.
Alert routes are configured by `infra/aws/operational-alerts.example.yaml`.
Never paste applicant data, evidence content, bearer links or secrets into an
incident ticket.

## `queue_job_exhausted`

1. Identify the queue and opaque job id from the log event. Do not inspect or
   export job payloads into third-party systems.
2. Check the named dependency and the immediately preceding retry logs.
3. For `malware-scan`, leave the object quarantined. Never mark evidence clean
   manually. Restoring ClamAV is enough while attempts remain: the job uses 24
   tries and a backoff capped at 10 minutes. Once attempts are exhausted the
   job is copied to `malware-scan-dlq` and the evidence sweep redrives it with
   a fresh job id (`evidence.scan_requeued`). Do not retry the old job id; BullMQ
   keeps it for 7 days. Confirm the dead-letter depth returns to zero.
4. For email/webhook/export, confirm whether the side effect happened before
   retrying. Processors are designed to be idempotent, but the operator must
   verify the external service response. A webhook marked `destination not allowed`
   or `endpoint secret unavailable` will not succeed on retry: correct the
   endpoint URL, or rotate the signing secret from the management API. The
   secret is shown once at creation and once at rotation. Do not copy it into
   the ticket.
   Exports recover on their own: the export maintenance sweep re-enqueues an
   export stuck `processing` for 15 minutes (a dead worker) and marks it
   `failed` after 3 interrupted attempts.
5. Record the remediation and confirm the queue’s failed count returns to its
   expected baseline.

### Webhook deliveries

- Webhook jobs retry on their own schedule (30s, 2m, 10m, 30m, 1h, 2h, 4h, 8h;
  nine attempts over ~16h), so a receiver outage of an hour or more does not
  lose events. Only after the last attempt is the delivery marked `failed`.
- A per-tenant `sweep` job on the `webhook` queue (every
  `WEBHOOK_SWEEP_INTERVAL_MS`, default 15 min) re-queues `pending` deliveries
  untouched for over 1h that have no live job, e.g. when Redis was unavailable
  at emit time. It shares the webhook worker, so it adds no DB pool slots.
- Once the receiver is healthy, a tenant admin (`tenant:configure`) may resend a
  `delivered` or `failed` delivery with
  `POST /api/webhooks/{endpointId}/deliveries/{deliveryId}/redeliver`. The
  request is audited as `integration.redelivery_requested`; a still-`pending`
  delivery is refused because it is already being retried.

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

## `evidence_quarantine_backlog`

The sweep logs `quarantinedCount`, `oldestQuarantinedAgeSeconds`, `dlqDepth`
and `redriven` for one organisation. Page when the oldest age stays at or above
30 minutes, or dead-letter depth stays above zero (`blakpath-oldest-quarantined-age`,
`blakpath-malware-scan-dlq`).

1. Confirm ClamAV is healthy and the worker is running. The sweep runs about
   every five minutes and re-queues quarantined evidence on its own.
2. Do not promote or download quarantined objects. Do not edit the row to
   `clean`.
3. After the scanner recovers, confirm new scan jobs finish `clean` or
   `infected` and the oldest age falls. A `pending` upload older than 24 hours
   is rejected as `expired:pending`; the applicant uploads again.

## `clamav_unavailable`

1. Confirm ClamAV task health, signatures, memory and network reachability.
2. Keep uploads enabled only if the quarantine backlog remains within capacity;
   no unscanned object may be promoted or downloaded.
3. Restore the scanner and watch BullMQ retries drain. Page if two consecutive
   five-minute periods report the signal.
4. The quarantine bucket expires objects after 2 days. An outage longer than
   that loses the affected uploads (records stay quarantined, never promoted);
   ask uploaders to re-submit rather than restoring objects from backup.

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

## Error page reference (`request error`)

Staff who hit the branded 500 page see a **Reference** to quote to support.

1. A numeric reference is the Next.js error `digest`. Search the structured logs
   for the `request error` event with that `digest`; it carries the route
   pattern (`routePath`, never the concrete URL), `routeType`, method and the
   correlation/request ids.
2. A reference starting `web-` was raised in the browser and has no server log
   line. Ask for the page and the time it happened instead.
3. A 403 ("Error 403") is an access decision, not an outage: it never produces a
   `request error` event. Check the person's role and membership instead.

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
