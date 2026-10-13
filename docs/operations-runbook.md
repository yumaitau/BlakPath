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
   verify the external service response.
5. Record the remediation and confirm the queue’s failed count returns to its
   expected baseline.

### Webhook deliveries

- Webhook jobs retry on their own schedule (30s, 2m, 10m, 30m, 1h, 2h, 4h, 8h;
  nine attempts over ~16h), so a receiver outage of an hour or more does not
  lose events. Only after the last attempt is the delivery marked `failed`.
- The per-tenant `webhook-sweep` queue (every `WEBHOOK_SWEEP_INTERVAL_MS`,
  default 15 min) re-queues `pending` deliveries untouched for over 1h that
  have no live job, e.g. when Redis was unavailable at emit time.
- Once the receiver is healthy, a tenant admin (`tenant:configure`) may resend a
  `delivered` or `failed` delivery with
  `POST /api/webhooks/{endpointId}/deliveries/{deliveryId}/redeliver`. The
  request is audited as `integration.redelivery_requested`; a still-`pending`
  delivery is refused because it is already being retried.

## `audit_integrity_failure`

1. Treat this as a security incident. Preserve database snapshots and relevant
   logs; do not edit, delete or “repair” audit rows.
2. Restrict administrative changes for the affected opaque organisation id.
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

## `readiness_dependency_down`

1. The load balancer should already have removed the affected web task because
   `/api/ready` returns 503.
2. Check the coarse `database`, `redis` and `storage` statuses in the same event,
   then use the managed service’s own telemetry. Connection strings never belong
   in logs or tickets.
3. Restore the dependency, confirm `/api/live` remained healthy and `/api/ready`
   returns 200, then confirm the alarm returns to OK.

## Backup or restore failure

Stop the drill or recovery, preserve its target, and do not promote a partial
restore. Confirm the source recovery point is immutable, open an incident, and
repeat into a new isolated target after correcting the fault. A restore is usable
only after sign-in, tenant records, evidence authorisation and every audit chain
have been verified.
