# Evidence scanning design

> **Status: implemented.** Uploads, quarantine, scanning and promotion follow
> this lifecycle (`src/domains/evidence/service.ts`, `worker/processors.ts`).
> Retry, dead-letter and sweep behaviour is in **Recovery** below. Configuration
> lives in `src/lib/env.ts` (`S3_BUCKET_EVIDENCE`, `S3_BUCKET_QUARANTINE`,
> `CLAMAV_HOST`, `CLAMAV_PORT`, and the `EVIDENCE_*` sweep settings).

Supporting evidence is the most sensitive data an applicant shares. Uploads are
therefore treated as **untrusted and potentially hostile** until proven clean.
The lifecycle is **fail-secure**: a file is never served until it has been
scanned and promoted, and if scanning cannot happen, the file simply waits in
quarantine.

## Principles

- **Quarantine first, serve last.** Every upload lands in a **quarantine bucket**
  (`S3_BUCKET_QUARANTINE`) and is only ever moved to the **evidence bucket**
  (`S3_BUCKET_EVIDENCE`) after a clean scan.
- **Fail secure.** If ClamAV is down, unreachable, times out or errors, the file
  **stays quarantined** and is never promoted. Availability of scanning is never
  traded for exposing an unscanned file (`docs/threat-model.md`).
- **Presigned, tenant-scoped, short-lived.** Uploads and downloads use presigned
  S3 URLs so bytes never flow through the app tier. Every object key lives under
  the tenant's namespace (`{organisation_id}/...`), and URLs are minted only for
  the caller's own tenant (`docs/tenant-isolation.md`).
- **Permission-checked and audited.** `evidence:upload`, `evidence:read`,
  `evidence:manage` gate the flow; each state transition is an audited event
  (`docs/authorization-matrix.md`, `docs/audit-log-design.md`).

## Lifecycle

```mermaid
sequenceDiagram
  participant U as User (browser)
  participant App as Next.js app
  participant Q as Quarantine bucket (S3)
  participant DB as PostgreSQL (evidence record)
  participant W as Worker (BullMQ)
  participant AV as ClamAV
  participant E as Evidence bucket (S3)

  U->>App: Request upload (filename, size, type)
  App->>App: Permission check (evidence:upload) + validate size/type
  App->>DB: Create evidence record (status = pending, tenant key)
  App->>Q: Mint presigned PUT (quarantine, {org_id}/...)
  App-->>U: Presigned URL
  U->>Q: PUT file bytes directly
  U->>App: Notify upload complete
  App->>DB: status = quarantined
  App->>W: Enqueue scan job (Zod payload: org id + object key)

  W->>DB: Re-verify tenant + load record
  W->>Q: Read object; verify content type (magic bytes)
  W->>AV: Scan stream (INSTREAM)
  alt clean
    W->>E: Copy object to evidence bucket ({org_id}/...)
    W->>Q: Delete quarantined copy
    W->>DB: status = clean (promoted)
    W->>DB: audit(evidence.promoted, success)
  else infected
    W->>Q: Delete or hard-hold object
    W->>DB: status = infected
    W->>DB: audit(evidence.rejected, failure)
    W-->>App: Notify uploader (safe, non-technical message)
  else scanner unavailable / error
    W->>DB: status stays quarantined (held)
    W->>DB: audit(evidence.scan_failed, failure)
    Note over W,AV: FAIL-SECURE — never promote, retry with capped backoff
  end

  Note over U,E: Later — download
  U->>App: Request evidence:read
  App->>App: Permission check + status must be clean
  App->>E: Mint short-lived presigned GET ({org_id}/...)
  App-->>U: Presigned URL (clean files only)
```

## States

| State         | Meaning                                                                            | Servable?                 |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `pending`     | Record created; awaiting the upload.                                               | No                        |
| `quarantined` | Bytes in quarantine bucket; scan queued/running or **held** (scanner unavailable). | No                        |
| `clean`       | Scanned clean and promoted to the evidence bucket.                                 | **Yes** (with permission) |
| `infected`    | Malware detected; object removed/hard-held.                                        | No — ever                 |

Only `clean` objects can be presigned for download, and only to a caller with
`evidence:read` inside the owning tenant.

## Validation & hardening

- **Pre-upload:** enforce allow-listed content types and a maximum size before
  minting the presigned PUT.
- **Post-upload (worker):** verify the real content type from magic bytes
  (`file-type`) against the declared type — reject spoofed extensions before
  scanning.
- **Scanning:** stream the object to ClamAV (`INSTREAM`) at
  `CLAMAV_HOST:CLAMAV_PORT`; do not load whole files into app memory.
- **Retries:** a `malware-scan` job uses 24 attempts and exponential backoff
  from 2 seconds, capped at 10 minutes (`src/lib/queues/scan-policy.ts`). A
  scanner outage causes retries, not promotion. The capped schedule still has
  attempts left after a 10 minute ClamAV gap, so the same job finishes
  `clean` or `infected` once the scanner is back.
- **Dead letter and redrive:** a scan that exhausts those attempts is copied to
  the `malware-scan-dlq` holding queue (no worker consumes it) and the
  `queue_job_exhausted` signal fires. The per-tenant sweep
  (`EVIDENCE_SCAN_SWEEP_INTERVAL_MS`, default 5 minutes) redrives each dead
  letter onto `malware-scan` with a **fresh job id** — the failed id stays
  reserved for 7 days — and writes `evidence.scan_requeued`. The same sweep
  re-queues a `quarantined` row older than
  `EVIDENCE_QUARANTINE_REQUEUE_AFTER_MS` (default 10 minutes) when no scan is
  active, waiting or delayed. The object stays quarantined until a scan settles
  it. `pending` uploads older than 24 hours are rejected
  (`expired:pending`).
- **Complete checks the object.** `completeUpload` calls `HeadObject` on the
  quarantine key and returns HTTP 409, leaving the row `pending`, when the
  object is missing or its size does not match the declaration.
- **Promote is idempotent.** If the evidence-bucket object already exists at
  the expected size, the scan marks the row `clean` and deletes any leftover
  quarantine copy. A crash between copy and the status update does not strand
  the row.
- **Backlog metric.** Each sweep logs `signal=evidence_quarantine_backlog` with
  `quarantinedCount`, `oldestQuarantinedAgeSeconds`, `dlqDepth` and `redriven`.
  The CloudWatch alarm `blakpath-oldest-quarantined-age` pages when the oldest
  age reaches 30 minutes. See `infra/aws/operational-alerts.example.yaml`.
- **Cleanup:** on promotion, the quarantine copy is deleted so unscanned/raw bytes
  don't linger. Infected objects are removed or hard-held for investigation, never
  left addressable.

## Isolation notes

- Object keys are always `{organisation_id}/...` in **both** buckets; a presign
  request for a key outside the caller's tenant namespace is refused — one of the
  automated isolation tests (`docs/tenant-isolation.md`).
- The scan job payload is untrusted input: it is Zod-validated and its
  `organisation_id` re-verified before the worker touches storage or the DB, and
  the worker runs under a fresh, DB-verified tenant context
  (`docs/architecture.md`).
