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
  allowlisted, and a denylist blocks secrets
  (`src/domains/audit/hash.ts`, `docs/audit-log-design.md`). Evidence content
  is not written there. The event row **does** store `ipAddress` and
  `userAgent`, so the trail is not free of personal data. Removing that is
  #80. It is not done.
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

Tenant content is **plaintext in PostgreSQL**. That includes applications,
evidence metadata, decisions, certificate rows and the other tenant tables.
File bytes are in object storage, not in those rows. There is no per-tenant
key, no BYOK, no external key store, no escrow and no client-side encryption.
The accepted design for those modes is
[`docs/adr/0001-customer-held-keys.md`](adr/0001-customer-held-keys.md). It is
not built (#119–#125). Do not describe it as a control the app already has.

What the code does today:

- **Field-encryption helper, unused on write paths.** `encryptField` /
  `decryptField` (`src/lib/encryption/envelope.ts`) mint a 256-bit data key,
  encrypt with AES-256-GCM, and wrap the data key with
  `ENCRYPTION_MASTER_KEY`. That value is a base64 32-byte environment variable
  (`src/lib/env.ts`). The application does not call KMS to create it, wrap it,
  or unwrap it. There is no encryption context and no additional authenticated
  data. `ENCRYPTION_KEY_VERSION` is stamped on the blob the helper returns.
  Unit tests call the helper. No domain writer does, so no tenant column is
  stored as an `EncryptedField`.
- **TOTP material is encrypted by Better Auth, not by that helper.** On
  Better Auth 1.6 the TOTP `secret` and backup codes are passed through
  `symmetricEncrypt` before insert: XChaCha20-Poly1305 with key
  SHA-256(`BETTER_AUTH_SECRET`). That is not `ENCRYPTION_MASTER_KEY` and not a
  KMS data key (`docs/authentication.md`). Plaintext exists in the auth
  process during enrolment and verification. Passwords are argon2 hashes.
  Passkeys store a public key only.
- **Objects use one platform KMS key in production.** `src/lib/storage/s3.ts`
  sets SSE-KMS to `S3_KMS_KEY_ID` when `NODE_ENV` is `production` and
  `S3_ENDPOINT` is unset. Every tenant shares that key. With a custom S3
  endpoint (local MinIO) the presign path does not set SSE.
- **KMS signing is not data encryption.** `src/lib/kms/sign.ts` signs the
  canonical certificate payload. It does not encrypt evidence or rows.
- **Redis payloads are ids.** Queue jobs carry `organisationId`,
  `correlationId` and opaque entity ids. They are not encrypted. The queue
  helper's contract is that applicant content is not placed in the payload
  (`src/lib/queues/index.ts`). That is a code convention, not ciphertext.
- **Logs must not contain plaintext.** Pino censors a fixed path list
  (secrets, names, email, ciphertext fields) in
  `src/lib/observability/logger.ts`. A message or field outside that list is
  not automatically removed. Operational logs are not the audit trail.
- **Backups and search.** There is no production backup implementation in
  this repo, and there is no search index or blind index. A database or
  bucket dump today would copy plaintext rows and objects under the platform
  key above.

Plaintext of tenant rows is persisted. It is not "memory only". The Tier 1
design, once built, will still decrypt into server memory for the life of a
request. That limit is written in the ADR so it is not mistaken for
zero-knowledge.

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

## Retention & deletion vs official records

- **Tenant-set defaults.** Retention periods are organisation-configured
  (`organisation_settings.retentionDefaults`).
- **Soft delete first.** The `softDelete` helper (`deletedAt`) supports
  reversible removal and grace periods before any hard deletion.
- **Worker-driven lifecycle.** Retention/deletion runs as background jobs
  (`docs/architecture.md`), tenant-scoped and audited.
- **Official records are protected.** A recorded determination or issued
  certificate is an official record; it is not casually deleted. Where deletion of
  ancillary data is lawful and requested, it happens without destroying the
  official record or the audit trail.
- **The audit trail is not deletable per-row.** Deleting individual audit rows
  would defeat tamper-evidence; audit retention is handled by whole, verified,
  archived periods, never by editing rows (`docs/audit-log-design.md`).

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
- **Never decides, scores or infers.** Even when enabled, AI may only assist with
  non-determinative convenience (e.g. drafting neutral correspondence, help with
  navigation). It must never evaluate identity, weigh evidence, produce a
  recommendation on an outcome, or influence a determination.
- **Human-in-authority, always.** Any AI output is a suggestion a human may edit
  or discard; it is never an action. AI-assisted actions remain
  permission-checked and audited like any other.
- **Data stays in-region and minimal.** AI features must respect data sovereignty
  and minimisation — no sending evidence, genealogy or determinations to offshore
  or third-party models.
