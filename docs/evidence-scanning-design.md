# Evidence scanning design

> **Status: design for Phase 3.** The tables and worker jobs described here are
> planned, not yet implemented. This document records the intended secure upload
> lifecycle so it is built correctly when the Evidence domain lands. The
> configuration it relies on already exists (`S3_BUCKET_EVIDENCE`,
> `S3_BUCKET_QUARANTINE`, `CLAMAV_HOST`, `CLAMAV_PORT` in `src/lib/env.ts`).

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
    W->>DB: audit(evidence.scan_deferred, failure)
    Note over W,AV: FAIL-SECURE — never promote, retry with backoff
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

- **Pre-upload:** enforce allow-listed content types and a maximum size (25 MiB)
  before minting the presigned PUT. The upload form checks type and size in the
  browser first, with plain-language errors, but the server is authoritative.
- **Signed PUT:** the presigned URL signs `Content-Type` and `Content-Length`
  (the presigner leaves `Content-Type` unsigned unless asked), so S3 refuses a
  PUT whose type or size differs from the declaration.
- **Post-upload (worker):** `HeadObject` first — the stored size must equal the
  declared size and stay within the cap, or the upload is rejected
  (`rejected:size`). Every later read and the promotion copy are pinned to that
  `ETag`, so a re-upload cannot swap bytes between checks.
- **Content type (worker):** verify the real content type from magic bytes
  (`file-type`, streamed) against the declared type — reject spoofed extensions
  before scanning. Known container equivalences are accepted: a legacy `.doc`
  is detected as an MS Compound File (`application/x-cfb`) and is accepted as
  `application/msword` only when the file name ends in `.doc`; HEIC and HEIF
  share a container and are interchangeable. Unidentifiable bytes are rejected.
- **Scanning:** stream the object to ClamAV (`INSTREAM`) at
  `CLAMAV_HOST:CLAMAV_PORT` in 64 KiB frames with socket backpressure, hashing
  (SHA-256) on the way; whole files are never loaded into app memory.
- **Promotion:** the copy into the evidence bucket replaces the object metadata
  (`MetadataDirective: REPLACE`) and sets `Content-Type` to the verified type,
  never the client-declared one.
- **Retries:** scan jobs use BullMQ retry with backoff. A scanner outage causes
  retries, not promotion; persistent failures are dead-lettered and alerted while
  the file remains quarantined.
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
