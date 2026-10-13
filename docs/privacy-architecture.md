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

- A **data key** encrypts the field with **AES-256-GCM** (authenticated
  encryption — confidentiality and integrity). The data key is itself wrapped by
  a **master key** managed by KMS in production
  (`ENCRYPTION_MASTER_KEY` is a base64-encoded 32-byte key; in production it is
  sourced from KMS, never the database — `src/lib/env.ts`).
- **Key versioning** (`ENCRYPTION_KEY_VERSION`) is stored alongside ciphertext so
  keys can be rotated without a flag-day re-encryption.
- Applied to authentication secrets today — the TOTP `secret` and `backupCodes`
  in `two_factors` store **ciphertext only** — and to sensitive evidence/identity
  fields as those domains land (`src/db/schema/auth.ts`,
  `docs/authentication.md`).
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

## Individual rights

Requests from a person about their own information are handled in
`src/domains/privacy/` by staff holding `privacy:manage` (records officers by
default). Every step is a recorded human act and is audited with metadata only.

- **Register.** Access, correction, complaint, consent-withdrawal and erasure
  requests are logged in `rights_requests` with a statutory due date (30 days by
  default: APP 12.4, APP 13.5 and OAIC complaint guidance — see
  `src/domains/privacy/rules.ts`). A due date only ever moves later, and only
  with a recorded reason. The staff screen is `/privacy-requests`.
- **Subject bundle (APP 12).** One action compiles everything held about the
  person across applications, status history, evidence metadata, evidence
  requests, family links, form invitations and responses, notes shared with the
  applicant, consents, representative authorisations, finalised decisions,
  certificates, associated statements and their earlier requests. Tables left
  out are listed with reasons in `BUNDLE_EXCLUSIONS`. Staff redact records or
  fields (for example third-party information) before a PDF is produced; both
  compiling and exporting need step-up.
- **Correction (APP 13).** Only registry-marked fields (names, contact details,
  intake) can be corrected, and only on the person's own records. Where the
  organisation declines, the person's statement is attached to the record in
  `associated_statements` (APP 13.4) and travels with it in every bundle.
- **Erasure.** `src/domains/privacy/registry.ts` classifies every table and
  every text/JSON column in the schema (a unit test fails on anything
  unclassified). Erasure, run by the worker, anonymises every personal column of
  every subject table, deletes every version of the stored evidence files, and
  saves a report on the request. It never touches official records (decisions,
  votes, certificates, the audit trail, request handling records); on a decided
  or certified matter it also keeps the applicant name and the committee's
  review record. Anything under a legal hold is left untouched.
- **Complaints.** Every complaint carries regulator escalation wording (OAIC and
  each state and territory regulator), shown to staff and on `/privacy`.
- **Tenant offboarding.** An administrator (`tenant:configure`, step-up, typing
  the organisation slug) requests a JSON export of every tenant row, downloads
  it, then confirms the purge. The worker deletes every object version under the
  tenant prefix and the organisation row, which cascades to every tenant table.
  The audit trail and the `tenant_offboardings` record are kept. Global sign-in
  identities are not tenant data and are not deleted.

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
