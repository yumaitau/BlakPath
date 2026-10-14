# Privacy architecture

BlakPath is built to hold identity evidence, genealogy and determinations with
the care that information deserves. Privacy here is not a bolt-on: it is
data minimisation, Australian data sovereignty, encryption only where the code
actually applies it, recorded consent, thoughtful retention, and hard limits
on automation.

> The foundational privacy and safety guarantee: **BlakPath never determines
> Aboriginality.** It does not score, rank, predict, infer, auto-approve or
> auto-reject. Determination authority rests entirely with authorised humans in
> the organisation. Everything below serves that guarantee.

## Data minimisation

- **Collect only what the organisation asks for.** Evidence requirements are
  tenant-configured (`organisation_settings.evidenceRequirements` in
  `src/db/schema/tenancy.ts`); the platform does not demand a fixed dossier.
- **Relational data stays relational.** JSONB is used only for genuinely flexible,
  organisation-authored config (terminology, guidance, branding) — never for data
  other modules must query, and never to smuggle in identity judgements.
- **Audit stores metadata, not payloads.** `beforeMeta`/`afterMeta` are
  allowlisted and capture changed field names, statuses and ids. A denylist
  (`src/domains/audit/hash.ts`) blocks secrets, names, contact details, notes
  and file names, so form answers and evidence content are not written there.
  `reason` is a code, with free text left on a mutable row
  (`docs/audit-log-design.md`). Retention can anonymise the application row
  without leaving the applicant's name in `audit_events`, because the trail
  never received it. The trail itself is not edited. The event row **does**
  still store `ipAddress` and `userAgent`, so the trail is not entirely free
  of personal data.
- **Ids don't leak counts.** UUIDv7 identifiers are non-sequential and
  public-safe, so exposing an id never reveals how many records exist
  (`src/db/schema/_helpers.ts`).

## Data sovereignty (Australian hosting)

- All infrastructure and data reside in **`ap-southeast-2` (Sydney)**:
  `APP_REGION` / `S3_REGION` default to `ap-southeast-2`, and every organisation
  row records its `region`, defaulting to `ap-southeast-2`
  (`src/lib/env.ts`, `src/db/schema/tenancy.ts`).
- PostgreSQL, Redis, object storage, backups and the worker all run in-region.
- Third-party processing that would move data offshore is not used for evidence,
  genealogy or determinations.

## Encryption at rest (what is implemented)

The custody decision (modes, trust boundaries, escrow, and what is still
deferred) is
[`docs/adr/0001-customer-held-keys.md`](adr/0001-customer-held-keys.md).
The client-facing summary is [`customer-held-keys.md`](customer-held-keys.md).

Inventoried tenant columns are sealed under the organisation's key (see
[Tenant data classes](#tenant-data-classes-under-the-tenant-key)). Every other
tenant column is still **plaintext in PostgreSQL**: for example evidence
metadata, decision outcomes and certificate rows. File bytes are in object
storage under the tenant key, not in those rows.

- A fresh **data key** encrypts the field with **AES-256-GCM**. KMS
  `GenerateDataKey` wraps that data key under the organisation's CMK (or an
  external key store key). The encryption context is `{org_id, purpose}`.
  Platform-owned data uses a separate platform CMK (`PLATFORM_KMS_KEY_ARN`),
  not a tenant key.
- The stored envelope is version 2: key id (ARN and version), encryption
  context, nonce, tag, wrapped data key, and ciphertext. Additional
  authenticated data binds the value to its table, column, row and organisation.
  Nothing writes version 1 any more. A version-1 reader remains only so older
  ciphertext can be migrated. `ENCRYPTION_MASTER_KEY` is that legacy reader
  key. It is needed only until the backfill below has run for every tenant;
  after that it can be removed from the environment.
- `organisation_keys` records custody mode, key ARN, version, status
  (`pending_validation`, `active`, `disabled`, `pending_deletion`,
  `unavailable`), validation (`pending`, `passed`, `failed`) and whether an
  escrow copy exists. A tenant cannot become `active` until validation has
  passed. Escrow is opt-in, needs a signed consent reference and the escrow
  package digest, and is cleared on rotation
  ([`key-escrow-runbook.md`](key-escrow-runbook.md)). Changes are appended to
  the platform audit chain. A worker re-checks the key every five minutes.
  Client templates and the XKS notes are in `docs/client-key-onboarding.md`.
- Organisation administrators see custody mode, key ARN, status, last health
  check, last rotation, escrow status and the key's change history on
  Settings → Encryption keys (`/settings/encryption-keys`, step-up required).
  A health check wraps and unwraps a throwaway data key with purpose
  `key_health`. Views are audited on the tenant chain; checks and status
  changes on the platform chain. The client trust pack is
  [`customer-held-keys.md`](customer-held-keys.md) (draft).
- A disabled or unreachable key fails closed (`TenantKeyUnavailableError`).
  The API returns 423 or 503 with code `TENANT_KEY_UNAVAILABLE`. There is no
  plaintext fallback. Unwrapped data keys stay in a process-local cache for at
  most five minutes and are zeroed when dropped.
- Local development and CI use a deterministic local provider. Production
  refuses `ENCRYPTION_LOCAL_KEY` and `KMS_ENDPOINT`.
- Revocation fails closed inside the data-key cache TTL. KMS automatic rotation
  keeps the same CMK ARN. A replacement CMK re-wraps envelopes and copies
  objects under the new SSE-KMS key. Crypto-shredding verifies the key no
  longer opens a sample, then purges ciphertext. The destruction certificate
  keeps residual counts and timestamps only. AWS Backup copies of that
  ciphertext become unreadable when the tenant key is deleted. Detail is in
  [`key-lifecycle.md`](key-lifecycle.md).
- **TOTP material is encrypted by Better Auth, not by the tenant key.** On
  Better Auth 1.6 the TOTP `secret` and backup codes are passed through
  `symmetricEncrypt` before insert: XChaCha20-Poly1305 with key
  SHA-256(`BETTER_AUTH_SECRET`). That path does not call KMS and does not use
  `organisation_keys` (`docs/authentication.md`). Plaintext exists in the auth
  process during enrolment and verification. Passwords are argon2 hashes.
  Passkeys store a public key only.
- **KMS signing is not data encryption.** `src/lib/kms/sign.ts` signs the
  canonical certificate payload. It does not encrypt evidence or rows.
- **Plaintext in memory.** The web process and the worker hold plaintext in
  memory while they serve a permitted request or job. Zeroing a data key is
  hygiene, not a boundary against a compromised process. Plaintext is not
  written to logs by design, but the pino redaction list is a list, not a
  proof. Client-side (Tier 2) encryption, where the server never sees the
  bytes, is not built (#124).

## Tenant data classes under the tenant key

RDS storage encryption and the shared bucket key are platform controls. A
per-tenant guarantee is application field encryption plus per-object keys.
Text columns store a canonical version-2 envelope string that starts with
`{"v":2`. JSONB columns store the same envelope as an object. Null stays null
and is not residue.

Inventoried columns:

- `applications.applicant_name` and `applications.intake`
- `family_links.relative_name`, `community`, `notes`, `decision_note`
- `form_responses.answers` and `respondent_email`
- `clients.contact_email`, `contact_phone`, `notes` (`display_name` stays readable)
- `application_notes.body`
- `decisions.rationale`
- `webhook_endpoints.secret`
- `correspondence_messages.recipient`, `subject`, `text_body`, `html_body`
- `consent_records.wording_snapshot` (the wording copied at grant time)
- `membership_invitations.token_seal` and `form_invitations.token_seal` (the
  bearer token held until the invitation email is sent; JSONB envelope)

`applications.reference` stays readable so staff can see the matter number.
Lookup does not use a plaintext index on that column.

This is not a full correspondence product and not a full append-only consent
ledger. Those remain separate work. The wording snapshot and the outbound
email holding table exist so those bodies sit under the tenant key.

### Blind index

Reference and name search uses HMAC-SHA256. The HMAC key is generated once
with encryption context `{org_id, purpose: blind-index}` and the wrapped key
is stored on `organisation_keys.blind_index_wrapped_dek`. Terms are trimmed,
lower-cased, and collapsed. The index stores the HMAC of the full string and,
for names, of each whole word, so "smith" matches "Jane Smith". A fragment
inside a word does not match. The unique index is
`(organisation_id, reference_bidx)`. There is no unique index on the plaintext
reference.

The blind index is a lookup aid. It does not score, rank, predict, or infer
Aboriginality, and it never approves or rejects an application.

### Object storage

Evidence, quarantine, certificate, and export objects use SSE-KMS with the
tenant CMK (`x-amz-server-side-encryption-aws-kms-key-id`). S3 Bucket Keys are
off on those objects so the key id recorded on the object is the tenant key.
`S3_KMS_KEY_ID` (`alias/blakpath-prod-evidence`) is the bucket default only.
Local development, where `S3_ENDPOINT` is set, skips SSE headers so MinIO
works, and still refuses upload and download when the tenant key is missing
or disabled. The evidence scanner decrypts in memory and zeroes that buffer
before returning. It does not write decrypted bytes to disk.

The example workload role allows `kms:Decrypt`, `kms:Encrypt`, and
`kms:GenerateDataKey` when `kms:ViaService` is
`s3.ap-southeast-2.amazonaws.com` and the encryption-context object ARN is in
the evidence or quarantine bucket. It also allows the `blind-index` encryption
context on tenant envelope calls. Applying that policy is an operator step.

### Queues, logs, and OAuth tokens

BullMQ payloads carry identifiers only: `organisationId`, `correlationId`,
fields ending in `Id`, and a backfill `cursor` of the form `table:rowId`.
Outbound email is inserted into `correspondence_messages` first. The job
carries `messageId`. The worker decrypts the body in memory and does not log
it. Operational logs redact every inventoried field name, including nested
paths.

OAuth tokens use Better Auth `account.encryptOAuthTokens` under
`BETTER_AUTH_SECRET`, the platform secret, not the tenant CMK. Better Auth
leaves a stored token unchanged when it does not look encrypted. A token that
is already an even-length hex string can be mistaken for ciphertext.

### Backfill and fail closed

The `encryption-backfill` queue walks one table per batch. The cursor is
`table:rowId`. Version-2 envelopes stay. Version 1 and legacy plaintext are
sealed under the tenant key. The job is not scheduled. An operator enqueues it
per organisation. Each batch and the completion are audited with the table
name and the row count only. `PLAINTEXT_RESIDUE_SQL` counts non-null values
that are not version-2 envelopes. A finished run leaves every count at 0.
Once every organisation has a completed run, no stored value needs
`ENCRYPTION_MASTER_KEY` and it can be removed.

A disabled, pending-deletion, or unreachable tenant key fails closed
(`TenantKeyUnavailableError`). Record reads and evidence downloads throw. They
do not return ciphertext or fall back to the shared bucket key. Proving that
against a revoked KMS key in staging is an operator step. Registering a real
per-tenant CMK is also an operator step. Until then, development uses the
local tenant ARN, and the seed and pilot helpers may register
`PLATFORM_KMS_KEY_ARN` only when that variable is set.

## Consent ledger (planned)

Consent is treated as a first-class, recorded fact, not an implicit assumption:

- Consent wording is tenant-authored (`organisation_settings.consentWording`).
- Representative access (a parent for a child, an authorised advocate) is already
  modelled as time-boxed, revocable grants and carries a `consentRecordId`
  placeholder that the consent domain will populate
  (`representative_authorisations` in `src/db/schema/membership.ts`).
- The **consent ledger** (later phase) will record what was consented to, by
  whom, when, the wording shown, and any withdrawal — as an append-only history
  so consent state is always explainable and auditable.

## Public certificate checks

The public `/verify` page confirms a code, the issuing organisation, the status
and the seal. It does not display the holder's name or date of birth.

Certificates sealed with payload version 2 commit to a salted hash of the name
printed on the PDF, the PDF's SHA-256, and — when intake recorded one — a salted
hash of the date of birth. A verifier may type the name (and optionally the date
of birth) printed on the document and is told only whether those details match.
That comparison does not determine Aboriginality. It checks the printed details
against what authorised humans recorded.

Version 1 seals stay valid. They confirm the reference, organisation and date,
and the page says they do not confirm a printed name.

Lookups are written to the audit trail without the typed name or date of birth,
and both lookups and name checks are rate-limited.

## Retention & deletion vs official records

- **Disposal authority, not a software sentence.** Every resource type maps to a
  disposal class. A records manager signs the authority reference for a class in
  the organisation's jurisdiction. The software does not choose the statute, the
  class number, or the keep period (`docs/records-disposal.md`).
- **Two people to activate.** A retention policy is drafted inactive. A different
  `retention:manage` holder has to activate it. The drafter cannot activate their
  own policy.
- **No purge without an authority.** A purge runs only when the policy cites a
  current sign-off. Permanent retention (`retain`, no end date) is never due.
  Each committed purge is written to the destruction register, which can be
  exported.
- **Tenant-set defaults.** Organisation settings still carry
  `organisation_settings.retentionDefaults` for guidance. They do not by
  themselves authorise destruction.
- **Soft delete first.** The `softDelete` helper (`deletedAt`) supports
  reversible removal and grace periods before any hard deletion.
- **Worker-driven lifecycle.** Retention/deletion runs as background jobs
  (`docs/architecture.md`), tenant-scoped and audited.
- **Official records are protected.** A recorded determination (`decided`
  application or finalised decision) or an issued certificate is an official
  record (`official_outcome`). The retention sweep will not anonymise or purge
  it, or its evidence and form responses, unless the policy's disposal
  authority is verified: a second person activated the policy and its
  authority reference matches a current records-manager sign-off that is not
  marked permanent. A bare reference string does not unlock disposal. The
  audit trail is never a target.
- **Retention floor and grace.** A policy cannot be shorter than 30 days. Purge
  tombstones the database row, removes every S3 object version immediately, and
  hard-deletes the row only after a further 30-day grace. The hard delete runs
  only under a purge policy that still passes the signed-authority gate.
  Anonymised rows are marked and are not rewritten on later sweeps.
- **Legal holds cascade.** A hold on an application also shields its evidence,
  form responses, notes and family links. A hold on evidence or a form response
  keeps that record, and its parent application, out of the sweep. Holds can
  only be placed on a record that exists.
- **The audit trail is not deletable per-row.** Deleting individual audit rows
  would defeat tamper-evidence; audit retention is handled by whole, verified,
  archived periods, never by editing rows (`docs/audit-log-design.md`). The
  destruction register is the same kind of control record and is not a sweep
  target.

## No automated determination — the guarantee

- **No scoring, ranking, prediction or inference of Aboriginality anywhere.** No
  auto-approve, no auto-reject. The platform captures information and records the
  outcomes humans decide.
- Enum values describe **lifecycle and outcome states only** and never encode a
  judgement about a person's identity (`src/db/schema/enums.ts`).
- Tenant settings configure **guidance and presentation** (e.g.
  `eligibilityGuidance` is explicitly informational and non-determinative) — they
  cannot automate a determination (`src/db/schema/tenancy.ts`).

## AI boundaries

- **Off by default.** `AI_FEATURES_ENABLED` defaults to `false`
  (`src/lib/env.ts`), and the platform feature flag `aiFeatures` defaults to
  `false` and must be turned on explicitly by a human
  (`feature_flags` in `src/db/schema/tenancy.ts`).
- **External tool access is closed unless both are on.** `/api/mcp` responds
  404 while the platform flag is off. A tenant that has not opted in is refused
  (403) even when the platform flag is on. Opt-in is an organisation
  administrator action (`tenant:configure`) that requires step-up and a stored
  governance approval (`ai_governance_approvals`: reference, statement, approver).
  The change is audited as `admin.feature_flag_changed`.
- **Dedicated scopes.** Tool calls require `mcp:read` or `mcp:read-pii`. Other
  API-key scopes do not open the endpoint. Responses omit applicant names,
  contact and intake fields, and recorded decision outcomes unless the key
  holds `mcp:read-pii`. A key with an `mcp:` scope must declare a purpose and
  a destination. Calls are rate-limited per key, and the key id is stored on
  the audit entry (`resource_id` and `after_meta.keyId`).
- **Never decides, scores or infers.** Even when enabled, AI may only assist with
  non-determinative convenience (e.g. drafting neutral correspondence, help with
  navigation). It must never evaluate identity, weigh evidence, produce a
  recommendation on an outcome, or influence a determination.
- **Human-in-authority, always.** Any AI output is a suggestion a human may edit
  or discard; it is never an action. AI-assisted actions remain
  permission-checked and audited like any other.
- **Data stays in-region and minimal.** AI features must respect data sovereignty
  and minimisation — no sending evidence, genealogy or determinations to offshore
  or third-party models. The declared destination on an `mcp:` key is the
  record of where a council has agreed responses may go.
