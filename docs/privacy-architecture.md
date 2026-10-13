# Privacy architecture

BlakPath is built to hold identity evidence, genealogy and determinations with
the care that information deserves. Privacy here is not a bolt-on: it is
data minimisation, Australian data sovereignty, encryption of sensitive fields,
recorded consent, thoughtful retention, and hard limits on automation.

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
- **Audit stores metadata, not payloads.** `beforeMeta`/`afterMeta` capture
  minimal change context; evidence content and secrets are never written to the
  audit trail (`docs/audit-log-design.md`).
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

## Sensitive-field envelope encryption (AES-256-GCM)

Some fields are too sensitive to sit in plaintext even inside a tenant-scoped
database. These are protected with **envelope encryption**:

- A fresh **data key** encrypts the field with **AES-256-GCM**. KMS
  `GenerateDataKey` wraps that data key under the organisation's CMK (or an
  external key store key). The encryption context is `{org_id, purpose}`.
  Platform-owned data uses a separate platform CMK (`PLATFORM_KMS_KEY_ARN`),
  not a tenant key.
- The stored envelope is version 2: key id (ARN and version), encryption
  context, nonce, tag, wrapped data key, and ciphertext. Additional
  authenticated data binds the value to its table, column, row and organisation.
  A version-1 reader remains only so older ciphertext can be migrated.
  `ENCRYPTION_MASTER_KEY` is that legacy reader key. It is not required in
  production.
- `organisation_keys` records custody mode, key ARN, version, status
  (`pending_validation`, `active`, `disabled`, `pending_deletion`,
  `unavailable`), validation (`pending`, `passed`, `failed`) and whether an
  escrow copy exists. A tenant cannot become `active` until validation has
  passed. Changes are appended to the platform audit chain. A worker
  re-checks the key every five minutes. Client templates and the XKS notes
  are in `docs/client-key-onboarding.md`.
- A disabled or unreachable key fails closed (`TenantKeyUnavailableError`).
  The API returns 423 or 503 with code `TENANT_KEY_UNAVAILABLE`. There is no
  plaintext fallback. Unwrapped data keys stay in a process-local cache for at
  most five minutes and are zeroed when dropped.
- Local development and CI use a deterministic local provider. Production
  refuses `ENCRYPTION_LOCAL_KEY` and `KMS_ENDPOINT`.
- Plaintext exists only transiently in memory during a single operation; it is
  never logged (pino) and never persisted.

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
