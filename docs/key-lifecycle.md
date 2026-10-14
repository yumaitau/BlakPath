# Tenant key lifecycle

Key status is custody. It is not a judgement about a person. BlakPath does not
score, rank, predict, infer, auto-approve or auto-reject Aboriginality. Disabling
a key, replacing it, or scheduling it for deletion does not decide an application.

This note covers revocation, restore, rotation, replacement, and crypto-shredding
for the per-organisation CMK recorded in `organisation_keys`. KMS automatic
rotation of one CMK is not a replacement.

## Revocation

A client disables the key, removes the grant, or an operator sets the row to
`disabled` or `pending_deletion`.

- Staff requests fail closed. The staff shell shows: "Your organisation's
  encryption key is unavailable. Contact your key administrator." API responses
  use the same sentence with code `TENANT_KEY_UNAVAILABLE` (HTTP 423 when the
  row is disabled or pending deletion, HTTP 503 when KMS refuses access).
- Public forms and certificate verification do not say the link or certificate
  is missing. They say the page cannot be shown because the organisation's
  encryption key is unavailable, and they ask the reader to contact the
  organisation.
- The worker moves that tenant's jobs to delayed and throws BullMQ `DelayedError`.
  That does not increment attempts and does not exhaust retries. Other tenants
  keep running. An organisation with no key row is not paused.
- Data keys may stay in the process-local cache until the next health probe.
  The probe interval is 60 seconds and must stay inside the five-minute cache
  TTL. After the probe marks the key `unavailable`, or after an operator sets a
  non-active status, the cache for that organisation is dropped and the next
  read fails closed. A network error on one probe does not change status and
  does not pause other tenants.

`disabled` and `pending_deletion` are human states. A successful KMS probe does
not turn them back on.

## Restore

Re-enabling the CMK or putting the grant back does not require a deploy. The
next health probe that can generate and decrypt a throwaway data key sets an
`unavailable` row back to `active` and promotes the jobs this process delayed.
Jobs that were only delayed by the timer also run on their next wake once the
row is active. Setting `disabled` or `pending_deletion` back to `active` is an
operator action (`setOrganisationKeyStatus`). The following probe, or the delay
timer, resumes work.

## Rotation and replacement

KMS automatic rotation keeps the same CMK ARN. Existing wraps still decrypt.
BlakPath does not start a re-wrap for that.

Key replacement points the organisation at a new CMK ARN. `rotateOrganisationKey`
refuses the same ARN, a key that is not active, and a second replacement while
`previous_kms_key_arn` is set. It stores the old ARN on the row, inserts
`organisation_key_rewraps` with phase `fields`, and audits
`key.replacement_started`. New writes use the new ARN immediately. Decrypt still
accepts the previous ARN until the job clears it.

`replaceOrganisationKey` enqueues `key-rewrap`. The job:

1. Re-wraps each version-2 envelope in `tenant_encrypted_fields`. The data key
   and field ciphertext stay the same. `kid` and `wrappedDek` move to the new
   CMK. Issue #120 must upsert that catalog when it encrypts a field. Until
   then the catalog can be empty and the field phase finishes with nothing to do.
2. Copies each evidence and quarantine object onto itself with
   `ServerSideEncryption=aws:kms` and the new tenant CMK. A local S3 endpoint
   cannot pretend that rotation happened and the copy fails closed.
3. Checkpoints the cursor and counts after each saved item. Killing the worker
   loses at most the item in flight. The next attempt resumes. `last_error` is
   an error name, not a payload. Completion audits `key.rewrap_completed` once,
   then clears `previous_kms_key_arn`.

Progress is `phase`, `fields_done`, `objects_done`, and the optional totals.

## Crypto-shredding

Offboarding follows export and the contract steps in issues #42 and #46 before
any key is scheduled for deletion. The application order after that approval is:

1. Schedule deletion (`pending_deletion`). Reads fail closed and jobs pause.
   Audit `key.deletion_scheduled`.
2. In AWS, schedule the CMK for deletion (the waiting period is the client's).
   This repository does not call KMS.
3. Verify a sample no longer opens. Any decrypt rejection counts as unreadable.
   If plaintext still opens, destruction stops. The error does not include the
   recovered value, and nothing is purged.
4. Purge tenant ciphertext: encrypted-field envelopes and objects. The
   destruction certificate records residual metadata only: row counts, oldest
   and newest timestamps, and column names that are not personal information.
   It must not carry plaintext, ciphertext, wrapped data keys, or names of
   email, phone, address, or person fields.
5. Store `destruction_certificates`. The artefact
   `blakpath.destruction_certificate` version 1 is not wrapped by the tenant
   key and has no foreign key, so it can outlive the organisation row. Audit
   `key.destruction_certified` records the certificate id and counts, not
   contents. The audit chain is not deleted.

AWS Backup recovery points hold ciphertext under the tenant CMK. After that key
is deleted, those copies are not readable. Restoring a backup does not recreate
the key. Residual metadata is the certificate, not a second copy of the records.

Full deletion of domain rows, and the legal sign-off for export and disposal,
stay with the operator under #42 and #46. This code purges the encrypted-field
catalog and, through the shred ports, the objects the caller passes in.

## Restore drills

Drills for issues #18 and #54 must include tenant keys. A restored database and
bucket are ciphertext. The client has to re-establish the key grant (or escrow
release, where that custody mode was agreed) before the organisation can read.
Confirm, in the isolated target:

- tenant A fails closed until the grant exists, then reads again;
- tenant B is unaffected if only A's grant is missing;
- `audit-verify` is clean;
- the drill record states whether an AWS Backup recovery point was actually
  restored.

The local record `docs/restore-drills/2026-10-14-tenant-key-local.md` checks the
cryptographic property with the local key provider. It is not an AWS restore.
