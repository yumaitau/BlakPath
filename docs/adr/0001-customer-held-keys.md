# ADR 0001: Customer-held keys and custody modes

- **Status:** Accepted. The three Tier 1 custody modes, the validation
  handshake, fail-closed reads, rotation, crypto-shred and the escrow opt-in
  are implemented. Tier 2 client-side encryption is **Not implemented** (#124).
  The live XKS proxy test is deferred
  ([`0121-client-held-keys.md`](0121-client-held-keys.md)). What the code does
  today is in [Current implementation](#current-implementation).
- **Date:** 2026-10-13. Revised 2026-10-15 to match the key custody code on
  `main`.
- **Relates to:** #117 (epic), #119 (hierarchy), #120 (encrypt tenant data),
  #121 (BYOK / XKS onboarding), #122 (revoke, rotate, crypto-shred), #123
  (escrow), #124 (Tier 2 spike), #125 (client trust pack), #80 (no PII in
  audit metadata), #81 (field encryption, superseded by this epic), #42
  (contracts), #43 (Indigenous Data Sovereignty and governance).
- **Related documents:** client trust pack
  [`customer-held-keys.md`](../customer-held-keys.md) (draft), escrow
  procedure [`key-escrow-runbook.md`](../key-escrow-runbook.md), client
  onboarding [`client-key-onboarding.md`](../client-key-onboarding.md),
  lifecycle [`key-lifecycle.md`](../key-lifecycle.md).

> **BlakPath never determines Aboriginality.** Key custody does not score,
> rank, predict, infer, auto-approve or auto-reject identity. A disabled key
> stops the software reading ciphertext. It is not a determination. Outcomes
> remain recorded human acts.

## Context

BlakPath holds evidence, family and ancestry information, and the decisions
authorised organisations record about Confirmation of Aboriginality. Clients
are Aboriginal and Torres Strait Islander organisations and councils. The
trust aim in #117 is that the client controls the key that can read its
tenant data, can revoke that access, and can destroy the key so the data
cannot be read (crypto-shred), including copies in backups.

Two tiers:

- **Tier 1** (this ADR, built): the server decrypts with the tenant's KMS key
  and **holds plaintext in process memory while a request or job is
  processed**. Search, malware scanning, certificates, exports and email keep
  working. Tier 1 does not protect against someone who can read that process.
- **Tier 2** (later, #124): for selected classes, the client encrypts before
  the server sees the bytes. The server stores ciphertext only. Tier 2 is not
  designed in detail here and is not built.

## Decision

Each organisation has one **tenant key**: a symmetric KMS customer master key
(CMK) used only for that organisation's tenant data classes. It is recorded
in `organisation_keys` with a custody mode (`blakpath_managed`,
`client_owned`, `client_owned_escrow`), the key ARN and version, a status and
a validation result. A separate **platform key** (`PLATFORM_KMS_KEY_ARN`)
covers platform-owned data. The certificate **signing** key is a third key and
is not a data-custody mode.

A registered key starts as `pending_validation`. Only a passing handshake
makes it `active`, and an organisation cannot itself become `active` until its
key is `active` with validation `passed`.

Escrow is off unless the client records explicit, signed consent. It is
available only for imported key material (`client_owned_escrow`).

Crypto-shred is offboarding of the whole tenant key, not row delete. Deleting
a row does not delete the CMK. Scheduling CMK deletion requires a recorded
decision by the tenant's records authority. See
[Regulatory notes](#regulatory-notes).

## Custody modes

| Mode                                 | `custody_mode`        | Tier | Where the root key lives                                                                                                                                        | Who can disable it                                                                    | Client sees each use                                                 | Operator decrypts without the app?                                                                                       | Built?                                 |
| ------------------------------------ | --------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| BlakPath-managed per-tenant key      | `blakpath_managed`    | 1    | One CMK per organisation in the **BlakPath** AWS account (`infra/aws/tenant-cmk`). Origin `AWS_KMS`. Material is not exportable.                                | Admins of the BlakPath account, at the client's written request                       | No. CloudTrail is in the BlakPath account                            | **Yes.** IAM on that CMK is enough. This mode is tenant-scoped shred, not customer-held custody.                         | Yes                                    |
| Client BYOK                          | `client_owned`        | 1    | CMK in the **client's** AWS account (`infra/client-kms`). The key policy lets the BlakPath workload roles use it only for that `org_id` and source account.     | Client account admins, by disabling the CMK or removing BlakPath's policy statement   | Yes. KMS calls are logged in the **client** account                  | No direct `kms:Decrypt`. **Yes via the running app** while the policy allows it and a cached data key has not expired.   | Yes                                    |
| Client HYOK (KMS external key store) | `client_owned`        | 1    | KMS key origin `EXTERNAL_KEY_STORE` in the client's account. AES-256 material stays in the client's HSM. An XKS proxy in reach of `ap-southeast-2` answers KMS. | Client, by stopping the proxy, disconnecting the store, or disabling the external key | Yes, in the client account, plus whatever the HSM logs               | Same as BYOK, and only while the proxy answers. AWS and BlakPath do not store the HSM material.                          | App path yes; live proxy test deferred |
| Client key + BlakPath escrow         | `client_owned_escrow` | 1    | Same live path as BYOK, with origin `EXTERNAL` (imported in a key ceremony). The live CMK is in the client account. The escrow package is in a separate vault.  | Client, same as BYOK. Escrow does not keep the app working after disable              | Yes, for live use                                                    | Same as BYOK for live traffic. Recovery only through [release governance](#release-governance). The pod cannot reach it. | Yes (vault template is an example)     |
| Tier 2 client-side encryption        | n/a                   | 2    | A key the server never receives, for named classes only (#124)                                                                                                  | Whoever holds that client-side key                                                    | Not applicable to those bytes; the server does not call KMS for them | **No**, for Tier 2 classes. Tier 1 classes on the same tenant still follow their Tier 1 mode.                            | No                                     |

An XKS key is the same ARN shape as any other KMS key and is registered as
`client_owned`. XKS is supported in `ap-southeast-2`. Put the proxy and HSM
where the round trip to Sydney stays within AWS's latency guidance. An XKS key
is symmetric `ENCRYPT_DECRYPT` only. It cannot be asymmetric, HMAC,
multi-Region, automatically rotated, or imported (`Origin=EXTERNAL` and
`Origin=EXTERNAL_KEY_STORE` cannot be combined), so an XKS key cannot be
escrowed. The Confirmation signing key stays a normal asymmetric KMS key.
Holding the signing key does not confer the ability to read tenant data, and
holding the data CMK does not confer the ability to forge a certificate seal.

BlakPath-managed mode exists so a tenant can still be crypto-shredded per
organisation before that tenant is ready to run its own CMK. Do not describe
it as customer-held. Do not use it as a silent fallback when a client key
fails.

## Who can read plaintext

**Tier 1, every mode:** the web process and the worker decrypt under the
tenant key and keep plaintext in memory for the work they are doing. That
includes malware scanning, rendering a certificate PDF, building an export,
and sending email. Zeroing a data key (`Buffer.fill(0)`) is hygiene. It is not
a boundary. V8 can retain copies. A core dump is plaintext. Production must
not ship heap dumps off the box.

A compromised app pod is game-over for Tier 1 data of **every tenant whose key
that pod's role can still use**, plus whatever plaintext is already in memory.
One workload role used across tenants is the launch shape. Per-tenant pods are
not part of this decision. The client's control is to disable the key or
remove BlakPath's policy statement, after which that tenant's cached data keys
die within the [cache bounds](#data-key-caching). Other tenants stay up.

| Party               | BlakPath-managed CMK                                                                              | Client BYOK                                                                                    | Client HYOK (XKS)                                                                            | Client key + escrow                                                                                                                            | Tier 2 classes                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| BlakPath operator   | Can read. They administer the CMK. Break-glass is not required.                                   | Cannot call KMS as themselves. Can read by operating the app while the policy and cache allow. | Same as BYOK. Cannot pull material out of the HSM.                                           | Same as BYOK for live data. Two escrow officers acting together can open the escrow package. In split mode they also need M client custodians. | Ciphertext only.                                                                                 |
| AWS                 | Runs KMS. The API does not return CMK material. An admin of the BlakPath account can use the key. | Runs KMS in the **client** account. Use is in that account's CloudTrail.                       | Runs KMS but not the HSM. AWS does not hold the external key.                                | Imported material is stored by KMS in the **client** account. The escrow package is sealed to a KMS key in the separate escrow account.        | No plaintext if the client never sends the key.                                                  |
| Client admins       | App RBAC only, unless BlakPath has given them IAM. They cannot shred the key alone.               | Disable the CMK, edit its policy, read CloudTrail, and use the app under BlakPath RBAC.        | Same, plus the proxy and the HSM. Taking the proxy down stops new operations.                | Same as BYOK. Their authorised signatories must request any release, and in split mode their custodians hold the shares.                       | They, or the person they entrust, hold the only key.                                             |
| Compromised app pod | Plaintext in memory. Role can `GenerateDataKey` / `Decrypt` for every such tenant.                | Plaintext in memory until the key is revoked **and** cached data keys expire or are evicted.   | Same as BYOK. Proxy down stops new KMS operations. Cache can still decrypt until it expires. | Same as BYOK. The escrow key policy denies the workload account, so the pod cannot open the package.                                           | Ciphertext only for those classes. The same pod still sees Tier 1 plaintext for everything else. |

AWS staff access to KMS hardware is AWS's control, not ours. This ADR does not
claim that AWS employees cannot be compelled, and it does not claim that a
client CMK hides data from AWS beyond the KMS shared-responsibility model.
HYOK is the mode where the key material itself is outside AWS.

## Key hierarchy

```text
platform CMK (BlakPath account, PLATFORM_KMS_KEY_ARN)
  platform-owned envelopes (purpose=platform), e.g. webhook signing secrets

tenant CMK (one per organisation, mode as above, organisation_keys)
  data keys from KMS GenerateDataKey, context {org_id, purpose}
    AES-256-GCM field ciphertext, with AAD (purpose=field)
    HMAC key for the blind index (purpose=blind-index), wrapped once
  handshake and health canaries (purpose=key_validation, key_health)
  S3 SSE-KMS for evidence, quarantine, certificate PDFs and exports
    (S3 calls KMS; the app does not wrap those bytes a second time)

CoA signing key (asymmetric KMS, SIGN_VERIFY)
  seals canonicalCoaPayload only; never encrypts tenant data
```

### Tenant key

Symmetric CMK, `ap-southeast-2`, one organisation, one mode, one
`organisation_keys` row. The client key policy (`infra/client-kms`) allows
the BlakPath workload roles `kms:GenerateDataKey`, `kms:Decrypt`,
`kms:Encrypt` and `kms:DescribeKey`. Crypto calls require
`kms:EncryptionContext:org_id` and `aws:SourceAccount`. `DescribeKey` has no
encryption context, so it carries only the account condition. The workload
role is not allowed `kms:DisableKey`, `kms:ScheduleKeyDeletion`,
`kms:PutKeyPolicy` or `kms:CreateGrant`.

Revocation is the client's: disable the key, remove BlakPath's statement (or
revoke a grant if they chose one), or disconnect the external key store.

### Registration and validation

Registration is `POST /api/organisation-keys` after step-up. The row is
inserted as `pending_validation` / `pending`. `validateOrganisationKey` then
runs the handshake: `GenerateDataKey` + `Decrypt` under the tenant context,
then a negative `Decrypt` and a negative `GenerateDataKey` under
`org_id=blakpath-handshake-negative`. The negatives must be refused, which
proves the key policy is scoped to one organisation. Only a pass sets the key
`active` with validation `passed` and stores a canary ciphertext. A failure
leaves it `pending_validation` with the failure code. Every step appends a
platform audit event.

`POST /api/organisation/activation` refuses to set the organisation `active`
unless the key is `active` and validation has `passed`.

A worker sweep every `KEY_HEALTH_INTERVAL_MS` (default 5 minutes, never more
than the cache TTL) calls `DescribeKey` and probes the key. A state change
notifies organisation admins and on-call. Organisation admins can run a check
from Settings → Encryption keys (`purpose=key_health`).

### Data keys

Every encryption calls `GenerateDataKey` (`AES_256`) for a fresh data key.
One data key protects one value. The encryption context is exactly:

| Name      | Value                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `org_id`  | Organisation UUID. Not the organisation's name.                                                           |
| `purpose` | Closed set: `field`, `platform`, `blind-index`, `key_validation`, `key_health` (and `health` for sweeps). |

No table, column or row id in the context. No names, emails, document text or
other personal data. Context is logged in CloudTrail and is not secret. A
decrypt whose stored context does not match the caller's organisation or
purpose throws in our code **before** KMS is called. There is no
platform-key fallback.

Each value is stored as a version-2 envelope (`{"v":2,...}`): the key id (ARN
and key version), the encryption context, the nonce, the GCM tag, the wrapped
data key and the ciphertext. Version 1 (a local data key wrapped by
`ENCRYPTION_MASTER_KEY`) is read only so the backfill can re-seal it.

### Additional authenticated data

AES-256-GCM additional authenticated data (AAD) is
`blakpath-aad-v2|` followed by the table, column, row id and organisation id,
each length-prefixed so a value cannot shift a field boundary
(`fieldAad` in `src/lib/encryption/envelope.ts`). AAD stops a ciphertext being
moved to another row, column or tenant. The key version is in the envelope's
key id, not in the AAD.

### Data-key caching

In-process only (`src/lib/encryption/dek-cache.ts`). Never Redis, disk, logs,
audit, or another pod's memory.

| Bound           | Value                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL             | **5 minutes**, absolute from the time the plaintext data key was cached. Not extended by use. The constructor refuses a longer TTL.                                                     |
| Max uses        | **64** uses per cached unwrap, then the entry is dropped and zeroed.                                                                                                                    |
| Where           | The Node process that called KMS.                                                                                                                                                       |
| Negative result | On `AccessDeniedException`, `DisabledException` or `KMSInvalidStateException`, or a status change away from `active`: drop every cached data key for that organisation and fail closed. |

Disabling the CMK therefore makes the tenant unreadable within 5 minutes, and
sooner if the next KMS call fails or the health sweep marks the key. Other
organisations keep their own cache entries. Do not "heal" a failure by
re-encrypting under the platform key.

### S3

Evidence, quarantine, certificate PDFs and export files use **SSE-KMS with the
tenant CMK** (`x-amz-server-side-encryption-aws-kms-key-id`). The app does not
AES-wrap those objects a second time. The worker has to read plaintext to
scan, render and build exports. That is Tier 1 memory, as above.

S3's encryption context is the object ARN (`aws:s3:arn`), not `org_id`. The
workload policy needs a separate statement: `kms:ViaService` of
`s3.ap-southeast-2.amazonaws.com`, and the encryption-context object ARN in
the evidence or quarantine bucket. **S3 Bucket Keys stay off** so the key id
recorded on each object is the tenant key and per-object KMS events stay
visible. `S3_KMS_KEY_ID` is the bucket default only. When `S3_ENDPOINT` is set
(local MinIO), the code sends no SSE headers but still refuses upload and
download when the tenant key is missing or disabled.

Object keys are `{organisationId}/...`, including `certificates/` and
`exports/` under the evidence bucket.

### Blind index

Reference and name search uses HMAC-SHA256. The HMAC key is generated once
with context `{org_id, purpose: blind-index}` and stored wrapped on
`organisation_keys.blind_index_wrapped_dek`. Terms are normalised. The index
stores digests only. Equality leaks; there is no prefix, n-gram, fuzzy or
full-text index on a sensitive column. Shredding the CMK kills the index too.
Tier 2 classes would not be indexed on the server.

### Signing key

`src/lib/kms/sign.ts` signs `canonicalCoaPayload` (ids, reference, outcome,
verification code, timestamp). It does not encrypt. Production uses
`COA_SIGNING_KEY_ID`. Local PEM is refused in production. That split stays.
Do not point the signing key at the tenant data CMK or at an XKS key.

## Data classes

| Class                                     | Today                                                                                                                                                                                                                                                                                                                                                                                                                                         | Key                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| DB fields, inventoried                    | Applicant name and intake, family-link names and notes, form answers and respondent email, client contact details and notes, application notes, decision rationale, correspondence held for delivery, consent wording snapshot (`docs/privacy-architecture.md`). Version-2 envelopes.                                                                                                                                                         | Tenant CMK, `purpose=field`, AAD as above.                                                           |
| DB fields, not inventoried                | Evidence metadata, decision outcomes, certificate rows and the other tenant columns.                                                                                                                                                                                                                                                                                                                                                          | **Plaintext in PostgreSQL** under platform storage encryption. Extending the inventory is #120 work. |
| Evidence, certificate PDFs, exports in S3 | Quarantine bucket, then evidence bucket. PDFs at `{org}/certificates/{id}.pdf`. CSVs at `{org}/exports/{id}.csv`.                                                                                                                                                                                                                                                                                                                             | Tenant CMK via SSE-KMS. Bucket Keys off. Local endpoint: no SSE headers, tenant key still checked.   |
| Redis job payloads                        | BullMQ. Identifiers only: `organisationId`, `correlationId`, ids and a backfill cursor. Outbound email is stored in `correspondence_messages` first and the job carries `messageId`.                                                                                                                                                                                                                                                          | Not encrypted, because it holds no tenant content. Redis is not a source of truth.                   |
| Logs                                      | Pino redacts every inventoried field name, including nested paths, plus secrets and ciphertext fields (`src/lib/observability/logger.ts`).                                                                                                                                                                                                                                                                                                    | A string outside that list can still be logged. Never log plaintext, data keys or escrow material.   |
| Audit metadata                            | `beforeMeta` / `afterMeta` go through an allowlist and a secret denylist (`src/domains/audit/hash.ts`). The row also stores `ipAddress` and `userAgent`. `reason` is free text. Key events go on the platform chain.                                                                                                                                                                                                                          | Platform storage encryption and the hash chain. **Not free of personal data.** #80 is open.          |
| Backups                                   | AWS Backup copies the database and objects as stored.                                                                                                                                                                                                                                                                                                                                                                                         | Inventoried columns and objects stay ciphertext under the tenant CMK. Other columns are plaintext.   |
| Blind index                               | HMAC digests of references and names.                                                                                                                                                                                                                                                                                                                                                                                                         | HMAC key wrapped under the tenant CMK.                                                               |
| Users and auth                            | `users`, `accounts`, `sessions`, `verifications`, `passkeys`, `two_factors`. Passwords are argon2. Passkeys store a public key. TOTP `secret` and `backupCodes` are encrypted by Better Auth 1.6 with XChaCha20-Poly1305 under SHA-256(`BETTER_AUTH_SECRET`). OAuth tokens use Better Auth `encryptOAuthTokens` under the same secret. Platform secret in the process. Not the tenant CMK and not KMS. Sign-in works when a tenant CMK fails. |
| Platform-owned secrets                    | Webhook signing secrets and other platform envelopes.                                                                                                                                                                                                                                                                                                                                                                                         | Platform CMK (`PLATFORM_KMS_KEY_ARN`), `purpose=platform`.                                           |
| Billing                                   | No billing tables.                                                                                                                                                                                                                                                                                                                                                                                                                            | Platform key, when billing exists. No evidence in billing rows.                                      |
| Escrow material                           | Escrow package in the separate escrow account under Object Lock. Custodian shares on offline media in split mode. Only the package digest and consent reference are in `organisation_keys`.                                                                                                                                                                                                                                                   | Sealed to the vault's RSA-4096 KMS key. Not in Postgres, Redis, logs, the app image or a DB backup.  |

Certificate **public verification** and public forms have no staff session.
When the tenant key is unavailable they show a fixed "the organisation's
encryption key is unavailable" message (`public-degradation.ts`), not "invalid
certificate". The app must not keep a plaintext copy of sealed fields to make
verify "still work".

## Platform key

The platform CMK (`PLATFORM_KMS_KEY_ARN`) is in the BlakPath account and is
distinct from every tenant CMK. Disabling a tenant CMK must not stop
authentication, must not stop another tenant, and must not make the audit
hash chain unverifiable. The platform key is a worse confidentiality
boundary: BlakPath can use it. That is accepted because those records are
the operator's own system, not the client's evidence.

`ENCRYPTION_MASTER_KEY` is a base64 32-byte environment value. It is kept only
as the version-1 reader so older ciphertext can be re-sealed, and it is not
required in production. It is not a KMS key and must not become a second
unwrap path for tenant ciphertext. `ENCRYPTION_LOCAL_KEY` and `KMS_ENDPOINT`
are for development and CI and are refused in production.

## Failure modes

Fail closed for **that organisation only**. Never fall back to the platform
CMK, another tenant's CMK, or plaintext. Never queue the plaintext for a later
retry. Surface an error the tenant admin can act on (`TenantKeyUnavailableError`,
HTTP 423 or 503, code `TENANT_KEY_UNAVAILABLE`), without the protected value.

| Failure                    | What KMS does                                                                              | What we do                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key disabled               | `DisabledException` or `KMSInvalidStateException`.                                         | Evict that organisation's data-key cache, mark the key `unavailable`, append `key.unavailable`, fail the request. Re-enable, then **Check and restore access** returns it to `active`.        |
| Key pending deletion       | `KMSInvalidStateException`; after the AWS window (7 to 30 days), `NotFoundException`.      | Same fail-closed behaviour while pending. After deletion the ciphertext is unreadable. Escrow can restore only through the release procedure, into a **new** client CMK.                      |
| XKS proxy down             | The external key store is disconnected or the call fails because the proxy did not answer. | Treat as key unavailable. Do not switch the tenant to a BlakPath-managed CMK. Availability of one client's HSM is that client's availability.                                                 |
| KMS throttling             | `ThrottlingException`.                                                                     | The AWS SDK's default retries, then the request fails. BlakPath adds no retry and does not mark the key unavailable. Do not skip encryption. A throttle is not a reason to widen a policy.    |
| Cross-account policy drift | `AccessDeniedException` after a policy or grant change.                                    | Same as disabled: evict cache, mark `unavailable`, alert with organisation id and key id only. The health sweep reports the KMS error name so on-call does not "fix" it by writing plaintext. |

A bug that catches these errors and writes the row in the clear is a defect,
not a degraded mode.

## Rotation and crypto-shred

- **KMS automatic rotation** keeps the same CMK ARN and needs no action.
- **Replacement CMK** (`rotateOrganisationKey`): the new ARN becomes current,
  the previous ARN stays on the row so existing ciphertext still opens, and a
  re-wrap job re-wraps envelopes and copies objects under the new SSE-KMS key.
  Validation resets, and the escrow flag and package digest are cleared.
- **Crypto-shred**: `scheduleKeyDeletion` marks the key `pending_deletion`
  (reads fail closed, the worker pauses the tenant's jobs). The client or
  BlakPath schedules deletion in KMS. A destruction certificate records
  residual counts and timestamps only, outside the tenant key. Detail is in
  [`key-lifecycle.md`](../key-lifecycle.md).

## Escrow

Escrow is optional and opt-in. The default is no escrow.

Native `AWS_KMS` keys cannot be exported, so there is nothing to escrow after
creation. XKS material stays in the client HSM; recovery is the client's HSM
backup, and BlakPath does not take a copy. Escrow is only the **imported**
path (`client_owned_escrow`, `Origin=EXTERNAL`). The procedure is
[`key-escrow-runbook.md`](../key-escrow-runbook.md):

1. On an offline machine, `pnpm key-ceremony generate` creates 32 bytes from
   the OS CSPRNG, wraps them for import into the client CMK, and seals them to
   the escrow vault's RSA-4096 KMS public key. Plaintext material is never
   written to disk.
2. The client chooses **whole** mode (the vault holds the sealed material) or
   **split** mode (Shamir M-of-N; each custodian the client nominates holds one
   share sealed to the vault key, and the vault keeps only the manifest). In
   split mode neither the vault nor the custodians can recover alone.
3. The material is imported into the client CMK. The package is deposited in
   the escrow account under S3 Object Lock (compliance mode).
4. The key is registered as `client_owned_escrow`, then the opt-in is recorded
   with `recordEscrowOptIn`: consent reference, signing date, the SHA-256
   digest of `escrow-package.json`, and the recording user. It refuses any
   other custody mode. A database CHECK refuses `escrow = true` without all
   three consent fields. The event is `key.escrow_opted_in` on the platform
   chain.

The earlier draft of this ADR proposed a fixed Shamir 3-of-5 with BlakPath
holding at most one share. The implemented design differs: in whole mode
BlakPath's vault holds a complete sealed copy, protected by a separate
account, a KMS key that is disabled between ceremonies, and dual control. A
client that does not accept that should choose split mode, or no escrow. Say
this before they choose.

### Threats

| Threat              | What goes wrong                                                             | What this decision does about it                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Insider at BlakPath | Someone with production access reads tenant data, or takes the escrow copy. | Tier 1 still lets the workload role decrypt while the key policy allows it. The escrow key policy denies the workload account. Officer A can enable the key and read packages but cannot decrypt; officer B can decrypt but cannot enable or read. In whole mode two colluding officers suffice. |
| Coercion            | A demand that BlakPath produce a client's key or data.                      | The live path is the client's key: the client can disable it. Release requires the client's signatories, call-back verification, and notice to every registered contact. In split mode BlakPath alone cannot recover. This is not a promise about Australian law.                                |
| Lost custodians     | In split mode, fewer than M shares remain. The key cannot be rebuilt.       | Tell the client before they opt in. Recovery refuses fewer than M shares and checks the key check value. An annual drill in staging proves the procedure without the live key.                                                                                                                   |

### Release governance

1. **Consent first.** Escrow needs a signed consent specific to escrow,
   recorded with `recordEscrowOptIn`. General application consent
   (`organisation_settings.consentWording`) is not this consent.
2. **Who may ask.** The number of authorised signatories the escrow agreement
   requires, in writing, verified by call-back on the registered number. A
   support ticket is not enough.
3. **Notice and cooling-off.** Every registered contact and custodian is told.
   Default wait is 5 business days. Any registered contact can object, which
   halts the release and sends it to governance.
4. **Dual control.** Officer A and officer B, different named people, in the
   escrow account. Split mode also needs M custodians in person.
5. **Where the key goes.** Import into a **new** `Origin=EXTERNAL` CMK the
   client controls. Never re-import into the old key. BlakPath rotates the
   tenant to the new ARN, which clears the escrow flag. The client then moves
   to fresh material.
6. **Record.** Vault trail and platform audit events. No share, no key
   material, no personal data in the metadata. A report goes to the client
   and to governance (#43).
7. **Withdrawal.** `withdrawEscrow` records the withdrawal. Object Lock keeps
   the package until its retention ends, so withdrawal is paired with a
   rotation to un-escrowed material, after which the package opens nothing.
   Say this in the consent.

## Regulatory notes

These are design constraints for engineers. They are not legal advice and not
a finding that BlakPath complies with any statute.

**APP 11 (Australian Privacy Principles).** APP 11.1 is the duty to take
reasonable steps to protect personal information from misuse, interference,
loss, and unauthorised access, modification or disclosure. A client-held CMK,
encryption in transit (TLS), and tenant isolation are the steps this design
relies on for tenant content. They are reasonable only if the failure modes
above fail closed. APP 11.2 is destruction or de-identification when the
information is no longer needed. Crypto-shred counts for ciphertext **only
if** no plaintext remains: columns outside the inventory, logs, downloaded
exports, replicas and heap dumps are not shredded by deleting the key.
Turning on a CMK does not, by itself, satisfy APP 11.

**Councils and state requirements.** A council may be bound by its state or
territory privacy law and by its public-records law, instead of or as well as
the Commonwealth APPs. Which one applies is per jurisdiction. This ADR does
not restate those statutes. An official Confirmation record often has a
retention period. Destroying the tenant CMK makes the official record, the
evidence and the working files unreadable together, because there is one
tenant key. That can be unlawful if the records authority has not authorised
disposal. The software must not schedule key deletion from a row-level delete
or from offboarding automation. A person with records authority at the tenant
records the decision first. Contract support for that clause is #42.

**Indigenous Data Sovereignty (#43).** Customer-held keys are a technical
control that can support Indigenous Data Sovereignty: the community's
organisation can hold the means of access, see use (client CloudTrail), and
revoke it. They do not decide Aboriginality, they do not authorise secondary
use, and they do not replace free, prior and informed governance by the
people the records are about. #43 is the governance work. This ADR does not
adopt a community protocol on anyone's behalf.

**Escrow needs explicit tenant consent.** An escrow copy held by the operator
is a means of access outside the tenant's sole control. That is incompatible
with the custody promise unless the tenant agrees, in a record specific to
escrow, after the loss and coercion consequences above have been said in
plain language. Consent is revocable through withdrawal plus rotation. Do not
infer escrow consent from a deed, a pilot agreement, or the in-product
consent wording.

## Current implementation

Checked against `main` on 2026-10-15. If code changes, update this section in
the same change.

| Mechanism             | Fact                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custody record        | `organisation_keys` (`src/db/schema/organisation-keys.ts`): mode, ARN, version, status, validation status, canary, escrow fields, blind-index key. Domain code in `src/domains/organisation-keys/`. |
| Status values         | `pending_validation`, `active`, `disabled`, `pending_deletion`, `unavailable`. Validation `pending`, `passed`, `failed`.                                                                            |
| Handshake             | `validateOrganisationKey` / `src/lib/encryption/key-handshake.ts`. Only a pass sets `active`. Organisation activation requires it.                                                                  |
| Field encryption      | `scopeFor` / `src/lib/encryption/scope.ts`, version-2 envelopes, `{org_id, purpose}` context, length-prefixed AAD.                                                                                  |
| Key providers         | `KmsKeyProvider` in production. The local provider is for development and CI and is refused in production.                                                                                          |
| Cache                 | 5-minute TTL, 64 uses, evicted per organisation on failure or status change.                                                                                                                        |
| Health                | Worker sweep every `KEY_HEALTH_INTERVAL_MS`; on-demand check on Settings → Encryption keys.                                                                                                         |
| Rotation and shred    | `rotateOrganisationKey` plus re-wrap job; `scheduleKeyDeletion`; `recordDestructionCertificate`.                                                                                                    |
| Escrow                | `recordEscrowOptIn`, `withdrawEscrow`, `pnpm key-ceremony`, `infra/aws/escrow-vault.example.yaml` (example, not deployed).                                                                          |
| TOTP and backup codes | Better Auth 1.6 `symmetricEncrypt`: XChaCha20-Poly1305, key SHA-256(`BETTER_AUTH_SECRET`). Not the envelope helper and not KMS.                                                                     |
| Audit                 | Allowlist plus secret denylist. `ipAddress` and `userAgent` are stored. #80 open.                                                                                                                   |
| Not implemented       | Tier 2 (#124). Live XKS proxy test (deferred). Encryption of tenant columns outside the inventory. Billing.                                                                                         |

## Not done in this ADR

Counsel still has to review the escrow agreement, the trust pack and the
records clause (#42). Community governance for Indigenous Data Sovereignty is
#43. Per council, a records officer has to authorise any key destruction.
Deploying client CMKs, the tenant CMK template, the escrow vault and XKS is
human work. This document does not apply infrastructure.
