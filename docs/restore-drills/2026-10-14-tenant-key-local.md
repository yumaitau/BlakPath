# Tenant-key local drill — 14 October 2026

- Operator: automated unit tests on branch `grok/issue-122`
- Date: 2026-10-14
- Environment: local key provider (HKDF per CMK ARN, AES-GCM wrap). No AWS
  account, no AWS Backup recovery point, no production data.

This record does not replace the managed `ap-southeast-2` restore drill in
issues #18 and #54. A restored environment still needs the client key grant
re-established before tenant ciphertext can be read. AWS Backup copies stay
ciphertext under the tenant CMK and were not restored here.

## What was exercised

Command: `pnpm test` on 2026-10-14. Result: 258 passed, 8 skipped.
Integration tests stay skipped unless `RUN_INTEGRATION` is set. `pnpm typecheck`,
`pnpm lint`, and `pnpm format:check` also passed. Lint reported only existing
warnings outside this change.

- `tests/unit/key-health.test.ts`: disabling tenant A's key leaves a cached
  read working until the health probe. Within the DEK cache TTL the probe marks
  A `unavailable`, A's reads throw `TENANT_KEY_UNAVAILABLE`, A's jobs are
  delayed without a BullMQ failure, and tenant B still encrypts and decrypts.
  Re-enabling A and running the probe restores A and leaves B active. A key
  `pending_deletion` stays paused even when a probe would succeed. A network
  error on A's probe does not pause B.
- `tests/unit/key-rewrap.test.ts`: replacement re-wraps 10,000 fields and 1,000
  objects, stops when one save throws, resumes from the last checkpoint, and
  finishes with every field and object on the new key. Samples open only under
  the new CMK.
- `tests/unit/crypto-shred.test.ts`: after the local key is marked deleted, a
  database envelope, an object copy, and a byte-for-byte backup copy all fail
  to open. The shred then purges the field and object maps. The backup bytes
  are unchanged and still do not open. The destruction certificate does not
  contain the plaintext or the ciphertext. A sample that still opens does not
  purge.

## Not done in this drill

- No `aws backup start-restore-job`, no RDS snapshot restore, no S3 recovery
  point.
- No second AWS account and no real KMS grant removal.
- Applying migration `organisation_key_rewraps`, `tenant_encrypted_fields`, and
  `destruction_certificates` is a human step. Do not use `db:push` against a
  shared database.
