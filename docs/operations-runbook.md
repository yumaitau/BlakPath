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

### `blakpath-backup-job-failed`

`infra/aws/backup-plan.example.yaml` creates alarm `blakpath-backup-job-failed`.
It pages the on-call SNS topic when a backup job for the BlakPath vault fails,
is aborted, or expires. AWS Backup publishes those metrics only for a non-zero
count, so the alarm treats missing data as not breaching.

1. In `ap-southeast-2`, open the failed job. Record the resource ARN, job id and
   status. Do not copy object bodies, query results or applicant data into the
   ticket.
2. Leave the vault lock in place. Do not delete recovery points, shorten
   retention, or remove the lock to clear the alarm.
3. Common causes: the backup role cannot use the RDS or bucket CMK, bucket
   versioning is off, the database is already in another continuous backup plan,
   or the job overlapped an RDS maintenance window.
4. Fix the cause and wait for the next successful job. `list-protected-resources`
   must still include the RDS instance, the evidence bucket and the quarantine
   bucket. A protected resource appears only after a successful job.
5. Keep any restore isolated. Re-apply audited deletions that happened after the
   recovery point before anyone can use the restored data
   (`docs/offboarding.md`). Restored quarantine objects stay unscanned.

### Prove the alarm path

Deploy the stack first. Test-fire the alarm once, confirm the on-call channel
receives it, then reset the state. This checks the notification path. It does
not create a backup job.

```bash
aws cloudwatch set-alarm-state \
  --region ap-southeast-2 \
  --alarm-name blakpath-backup-job-failed \
  --state-value ALARM \
  --state-reason "BlakPath backup alarm test fire"
aws cloudwatch set-alarm-state \
  --region ap-southeast-2 \
  --alarm-name blakpath-backup-job-failed \
  --state-value OK \
  --state-reason "BlakPath backup alarm test fire reset"
```

### Confirm the vault after the first successful jobs

```bash
aws backup describe-backup-vault \
  --region ap-southeast-2 \
  --backup-vault-name blakpath-production
aws backup list-protected-resources --region ap-southeast-2
```

The vault lock is compliance mode, minimum 35 days and maximum 90 days. The
protected-resource list includes the RDS instance ARN and both bucket ARNs.
