# ADR 0001: Customer-held keys and custody modes

- **Status:** Accepted as the design. Not implemented. Nothing in this ADR is a
  claim about the running system. What the code does today is in
  [Current implementation](#current-implementation) and in
  [`docs/privacy-architecture.md`](../privacy-architecture.md).
- **Date:** 2026-10-13
- **Relates to:** #117 (epic), #119 (hierarchy), #120 (encrypt tenant data),
  #121 (BYOK / XKS onboarding), #122 (revoke, rotate, crypto-shred), #123
  (escrow), #124 (Tier 2 spike), #125 (client trust pack), #80 (no PII in
  audit metadata), #81 (field encryption, superseded by this epic), #42
  (contracts), #43 (Indigenous Data Sovereignty and governance).

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

That aim is not what the software does now. See
[Current implementation](#current-implementation).

Two tiers:

- **Tier 1** (this ADR, the launch design): the server decrypts with the
  tenant's KMS key and **holds plaintext in process memory while a request or
  job is processed**. Search, malware scanning, certificates, exports and
  email keep working. Tier 1 does not protect against someone who can read
  that process.
- **Tier 2** (later, #124): for selected classes, the client encrypts before
  the server sees the bytes. The server stores ciphertext only. Tier 2 is not
  designed in detail here and is not built.

## Decision

Each organisation has one **tenant root key**: a symmetric KMS customer
master key (CMK) used only for that organisation's tenant data classes.
Custody of that CMK is one of the Tier 1 modes below. A separate **platform
key** covers users, auth, billing and the audit chains. The certificate
**signing** key is a third key and is not a data-custody mode.

Escrow is off unless the tenant records explicit consent. The operator never
holds a full copy of a client key. When escrow is on, the operator holds at
most one Shamir share.

Crypto-shred is offboarding of the whole tenant key, not row delete. Deleting
a row does not delete the CMK. Scheduling CMK deletion requires a recorded
decision by the tenant's records authority. See
[Regulatory notes](#regulatory-notes).

## Custody modes

| Mode                                 | Tier | Where the root key lives                                                                                                                                          | Who can disable it                                                                    | Client sees each use                                                 | Operator decrypts without the app?                                                                                          | Built? |
| ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| BlakPath-managed per-tenant key      | 1    | One CMK per organisation in the **BlakPath** AWS account. Origin `AWS_KMS`. Material is not exportable.                                                           | Admins of the BlakPath account                                                        | No. CloudTrail is in the BlakPath account                            | **Yes.** IAM on that CMK is enough. This mode is tenant-scoped shred, not customer-held custody.                            | No     |
| Client BYOK                          | 1    | CMK in the **client's** AWS account. The BlakPath workload role receives a grant, not an admin policy. Origin is the client's choice except `EXTERNAL_KEY_STORE`. | Client account admins, by retiring the grant or disabling the CMK                     | Yes. KMS calls are logged in the **client** account                  | No direct `kms:Decrypt`. **Yes via the running app** while the grant exists and a cached data key has not expired.          | No     |
| Client HYOK (KMS external key store) | 1    | KMS key origin `EXTERNAL_KEY_STORE` in the client's account. AES-256 material stays in the client's HSM. An XKS proxy in reach of `ap-southeast-2` answers KMS.   | Client, by stopping the proxy, disconnecting the store, or disabling the external key | Yes, in the client account, plus whatever the HSM logs               | Same as BYOK, and only while the proxy answers. AWS and BlakPath do not store the HSM material.                             | No     |
| Client key + BlakPath escrow         | 1    | Same live path as BYOK, with origin `EXTERNAL` (imported). Shares are cut **before** import. The live CMK is in the client account.                               | Client, same as BYOK. Escrow does not keep the app working after disable              | Yes, for live use                                                    | Same as BYOK for live traffic. Reconstruction only through [release governance](#release-governance). The pod has no share. | No     |
| Tier 2 client-side encryption        | 2    | A key the server never receives, for named classes only (#124)                                                                                                    | Whoever holds that client-side key                                                    | Not applicable to those bytes; the server does not call KMS for them | **No**, for Tier 2 classes. Tier 1 classes on the same tenant still follow their Tier 1 mode.                               | No     |

XKS (external key store) is supported in `ap-southeast-2`. It is not supported
in the China regions. Put the proxy and HSM where the round trip to Sydney
stays within AWS's latency guidance (35 ms where possible). An XKS key is
symmetric `ENCRYPT_DECRYPT` only. It cannot be asymmetric, HMAC, multi-Region,
automatically rotated, or imported (`Origin=EXTERNAL` and
`Origin=EXTERNAL_KEY_STORE` cannot be combined). The Confirmation signing key
stays a normal asymmetric KMS key. XKS cannot host it. Holding the signing key
does not confer the ability to read tenant data, and holding the data CMK does
not confer the ability to forge a certificate seal.

BlakPath-managed mode exists so a tenant can still be crypto-shredded per
organisation before that tenant is ready to run its own CMK. Do not describe
it as customer-held. Do not use it as a silent fallback when a client key
fails.

## Who can read plaintext

**Tier 1, every mode:** the web process and the worker decrypt under the
tenant key and keep plaintext in memory for the work they are doing. That
includes malware scanning, rendering a certificate PDF, building an export,
and sending email. `Buffer.fill(0)` on a data key, as in
`src/lib/encryption/envelope.ts`, is hygiene. It is not a boundary. V8 can
retain copies. A core dump is plaintext. Production must not ship heap dumps
off the box.

A compromised app pod is game-over for Tier 1 data of **every tenant whose
grant that pod's role can still use**, plus whatever plaintext is already in
memory. One workload role with many grants is the launch shape. Per-tenant
pods are not part of this decision. The client's control is to retire the
grant or disable the key, after which that tenant's still-cached data keys
die within the [cache bounds](#data-key-caching). Other tenants stay up.

| Party               | BlakPath-managed CMK                                                                              | Client BYOK                                                                                   | Client HYOK (XKS)                                                                            | Client key + escrow                                                                                                              | Tier 2 classes                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| BlakPath operator   | Can read. They administer the CMK. Break-glass is not required.                                   | Cannot call KMS as themselves. Can read by operating the app while the grant and cache allow. | Same as BYOK. Cannot pull material out of the HSM.                                           | Same as BYOK for live data. Holds **at most one** escrow share. One operator, or the whole on-call rota, cannot rebuild the key. | Ciphertext only.                                                                                 |
| AWS                 | Runs KMS. The API does not return CMK material. An admin of the BlakPath account can use the key. | Runs KMS in the **client** account. Use is in that account's CloudTrail.                      | Runs KMS but not the HSM. AWS does not hold the external key.                                | Imported material is stored by KMS in the **client** account. Escrow shares are not stored in either production database.        | No plaintext if the client never sends the key.                                                  |
| Client admins       | App RBAC only, unless BlakPath has given them IAM. They cannot shred the key alone.               | Disable the CMK, retire the grant, read CloudTrail, and use the app under BlakPath RBAC.      | Same, plus the proxy and the HSM. Taking the proxy down stops new operations.                | Same as BYOK, and they hold the other shares. Escrow requires their prior consent.                                               | They, or the person they entrust, hold the only key.                                             |
| Compromised app pod | Plaintext in memory. Role can `GenerateDataKey` / `Decrypt` for every such tenant.                | Plaintext in memory until the grant is retired **and** cached data keys expire or are purged. | Same as BYOK. Proxy down stops new KMS operations. Cache can still decrypt until it expires. | Same as BYOK. The pod does not have escrow shares and must not be given a path to fetch them.                                    | Ciphertext only for those classes. The same pod still sees Tier 1 plaintext for everything else. |

AWS staff access to KMS hardware is AWS's control, not ours. This ADR does not
claim that AWS employees cannot be compelled, and it does not claim that a
client CMK hides data from AWS beyond the KMS shared-responsibility model.
HYOK is the mode where the key material itself is outside AWS.

## Key hierarchy

```text
platform CMK (BlakPath account)
  users, auth, billing, audit chains

tenant root CMK (one per organisation, mode as above)
  data keys from KMS GenerateDataKey
    AES-256-GCM field ciphertext, with AAD
    HMAC key for a blind index (separate purpose)
  S3 SSE-KMS for evidence, certificate PDFs and exports
    (S3 calls KMS; the app does not wrap those bytes a second time)

CoA signing key (asymmetric KMS, SIGN_VERIFY)
  seals canonicalCoaPayload only; never encrypts tenant data
```

### Tenant root key

Symmetric CMK, `ap-southeast-2`, one organisation, one mode. The organisation
row will eventually store the key id and the mode. That column is **not** in
the schema today. It lands with #119 / #121. The workload role is allowed
`kms:GenerateDataKey`, `kms:Decrypt` and `kms:DescribeKey` on that CMK. It is
not allowed `kms:DisableKey`, `kms:ScheduleKeyDeletion`, `kms:PutKeyPolicy` or
`kms:CreateGrant`. Grant administration is an onboarding path, not the pod.

Prefer a **grant** over putting the workload role in the key policy as a
standing admin. Retire the grant to revoke. For BYOK and escrow the grant
lives in the client account so the client can retire it without us.

### Data keys

`GenerateDataKey` (`AES_256`) with encryption context exactly:

| Name      | Value                                           |
| --------- | ----------------------------------------------- |
| `org_id`  | Organisation UUID. Not the organisation's name. |
| `purpose` | `db-field` or `blind-index`. Closed set.        |
| `table`   | Physical table name.                            |
| `column`  | Physical column name.                           |

No row id. No names, emails, document text or other personal data. Context is
logged in CloudTrail and is not secret. The grant constrains
`kms:EncryptionContext:org_id` to that tenant. A call with the wrong `org_id`,
or with no context, must throw in our code **before** it is sent. There is no
platform-key fallback.

Each encrypted value stores the KMS `CiphertextBlob` for the data key that
encrypted it, the nonce, the GCM tag, the key id and the context. A data key
encrypts at most **100 values**. It is then retired and never encrypts again.
Those values are not a whole table: stealing one data key does not decrypt
every row ever written in the column. The current `encryptField` helper mints
a local data key per value and wraps it with `ENCRYPTION_MASTER_KEY`. That
format is not the KMS format. No domain writer calls `encryptField` today, so
there is no blob migration. There **is** a plaintext-column migration (#120).

### Additional authenticated data

AES-256-GCM additional authenticated data (AAD) is the UTF-8 JSON object with
these keys in this order: `org_id`, `purpose`, `table`, `column`, `row_id`,
`v` (key version, integer). `row_id` is the row's primary key. AAD stops a
ciphertext being moved to another row, column or tenant. KMS context does not
include `row_id`, because context is fixed when the data key is minted and one
data key encrypts up to 100 rows.

`src/lib/encryption/envelope.ts` does not set AAD. #119 must. Ciphertext
without AAD is not this design.

### Data-key caching

In-process only. Never Redis, disk, logs, audit, or another pod's memory.

| Bound           | Value                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL             | **5 minutes**, absolute from the time the plaintext data key was unwrapped. Not extended by use.                                                                                       |
| Max uses        | **100** encryptions per data key (lifetime). **100** decryptions per cached unwrap, then drop the cache.                                                                               |
| Where           | The Node process that called KMS.                                                                                                                                                      |
| Negative result | On `AccessDeniedException`, disabled / pending-deletion state, or `NotFoundException` for that key: drop every cached data key for that organisation immediately and fail the request. |

Disabling the CMK therefore makes the tenant unreadable within 5 minutes, and
sooner if the next KMS call fails and the cache is purged. Other organisations
keep their own cache entries. Do not "heal" a failure by re-encrypting under
the platform key.

Decrypts after the cache miss call KMS again, so a retired grant is observed
on the miss. Encrypt retirement (100 values) is separate from the decrypt
cache: old blobs still decrypt via KMS after the encrypting key is gone from
memory.

### S3

Evidence bytes, certificate PDFs and export files use **SSE-KMS with the
tenant CMK**. The app does not AES-wrap those objects a second time. The
worker has to read plaintext to scan, render and build exports. That is Tier 1
memory, as above.

S3's encryption context is the object ARN (`aws:s3:arn`), not `org_id`. The
key policy needs a separate statement: `kms:ViaService` of
`s3.ap-southeast-2.amazonaws.com`, and `kms:EncryptionContext:aws:s3:arn`
matching the tenant prefix `{org_id}/` in the evidence and quarantine buckets.
**S3 Bucket Keys stay off.** With Bucket Keys, the context collapses toward the
bucket and the prefix condition stops working. Bucket Keys would also hide
per-object KMS events.

Today every production object shares one platform key, `S3_KMS_KEY_ID`
(`src/lib/storage/s3.ts`). When `S3_ENDPOINT` is set (local MinIO), the code
does not send SSE at all. Replacing that with the tenant CMK is #120 / #121.

Object keys are already `{organisationId}/...`, including `certificates/` and
`exports/` under the evidence bucket.

### Blind indexes

There is no search index and no blind index in the repo (no `tsvector`, no
HMAC lookup column).

When #120 needs equality search on an encrypted column:

- HMAC-SHA-256, key from `GenerateDataKey` with `purpose=blind-index` (not the
  field data key).
- Message is `org_id || table || column || normalised value`.
- Store the digest only.
- Equality leaks. No prefix, n-gram, fuzzy or full-text index on a sensitive
  column in this design.
- The HMAC key sits under the tenant CMK, so shredding the CMK kills the index
  too.
- Tier 2 classes are not indexed on the server.

### Signing key

`src/lib/kms/sign.ts` signs `canonicalCoaPayload` (ids, reference, outcome,
verification code, timestamp). It does not encrypt. Production uses
`COA_SIGNING_KEY_ID`. Local PEM is refused in production. That split stays.
Do not point the signing key at the tenant data CMK or at an XKS key.

## Data classes

| Class                                     | What exists in this repo today                                                                                                                                                                                                                                | Today                                                                                                      | Target key                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB fields (tenant content)                | Applications, evidence **metadata** (file name, request description, classification), decisions, certificate rows, forms, family, meetings, and the other tenant tables. Bytes of files are not in these rows.                                                | Plaintext in PostgreSQL. `encryptField` is not on any write path.                                          | Tenant CMK, `purpose=db-field`, AAD as above. No plaintext shadow column.                                                                                                                                        |
| Evidence, certificate PDFs, exports in S3 | Quarantine bucket, then evidence bucket. PDFs at `{org}/certificates/{id}.pdf`. CSVs at `{org}/exports/{id}.csv`.                                                                                                                                             | Production, no custom endpoint: one platform CMK (`S3_KMS_KEY_ID`). Local endpoint: no SSE from this code. | Tenant CMK via SSE-KMS. Bucket Keys off. Scanner and export worker see plaintext in memory.                                                                                                                      |
| Redis job payloads                        | BullMQ. Payload is `organisationId`, `correlationId`, and opaque ids (`src/lib/queues/index.ts`). Completed jobs kept 24 h, failed jobs 7 days.                                                                                                               | Not encrypted. Must not contain applicant content; the helper does not cryptographically enforce that.     | Stay identifier-only. Do not put tenant plaintext in Redis and then encrypt it. Redis is not a source of truth.                                                                                                  |
| Logs                                      | Pino. A path denylist censors passwords, tokens, email, names, `ciphertext`, `wrappedDek` and similar (`src/lib/observability/logger.ts`).                                                                                                                    | A string the denylist does not name can still be logged. Not a proof that plaintext never appears.         | Never log plaintext, data keys, KMS plaintext, escrow shares, or document bytes. Ids and error names only.                                                                                                       |
| Audit metadata                            | `beforeMeta` / `afterMeta` go through an allowlist and a secret denylist (`src/domains/audit/hash.ts`). The row also stores `ipAddress` and `userAgent`. `reason` is free text.                                                                               | Not encrypted. **Not free of personal data.** #80 is open.                                                 | Stay off the tenant CMK so the chain is still readable when the tenant key is disabled. #80 must remove personal data. Do not put evidence content here in the meantime.                                         |
| Backups                                   | Documented as a release-gate item (`docs/production-readiness.md`). Not implemented by this repo. Restore drills are logical dumps, not a production backup product.                                                                                          | A dump today would copy plaintext rows and objects under the platform S3 key.                              | Backups copy ciphertext and KMS blobs only. They must not re-wrap tenant objects under the platform CMK. Same region only. Pre-cutover plaintext recovery points are destroyed in #122, not kept "just in case". |
| Search indexes / blind indexes            | None.                                                                                                                                                                                                                                                         | Nothing to leak, and nothing to search ciphertext with.                                                    | Blind index only, as above. No plaintext inverted index.                                                                                                                                                         |
| Users and auth                            | `users`, `accounts`, `sessions`, `verifications`, `passkeys`, `two_factors`. Passwords are argon2. Passkeys store a public key. TOTP `secret` and `backupCodes` are encrypted by Better Auth 1.6 with XChaCha20-Poly1305 under SHA-256(`BETTER_AUTH_SECRET`). | Platform secret in the process. Not the tenant CMK. Not `ENCRYPTION_MASTER_KEY`. Not KMS.                  | Platform key. Sign-in must work when a tenant CMK is disabled. A person can belong to more than one organisation.                                                                                                |
| Billing                                   | No billing tables.                                                                                                                                                                                                                                            | n/a                                                                                                        | Platform key, when billing exists. No evidence in billing rows.                                                                                                                                                  |
| Platform audit chain                      | `audit_events` and checkpoints with `organisation_id` null, and the per-tenant audit rows.                                                                                                                                                                    | Plaintext. Tenant rows are tenant-scoped by query, not by key.                                             | Platform key, both chains. Tenant audit rows are not shredded with the tenant CMK. They must not hold personal data (#80).                                                                                       |
| Escrow shares                             | None.                                                                                                                                                                                                                                                         | n/a                                                                                                        | Offline. Not in Postgres, Redis, logs, the app image, or a database backup. The workload role cannot read them.                                                                                                  |

Certificate **public verification** decrypts the seal fields under the tenant
CMK (Tier 1). `canonicalCoaPayload` contains ids and the recorded outcome, not
a person's name. The PDF does contain the certificate as issued. When the
client disables the key, verification fails closed within the cache TTL. The
app must not keep a plaintext copy of the outcome beside the ciphertext to
make verify "still work".

## Platform key

The platform CMK is in the BlakPath account and is distinct from every tenant
CMK. It wraps, or is the store for, only:

- user and auth records, including the Better Auth secret material;
- billing, when that schema exists;
- the platform audit chain and the tenant audit rows (metadata only, no
  personal data once #80 is done).

Disabling a tenant CMK must not stop authentication, must not stop another
tenant, and must not make the audit hash chain unverifiable. The platform key
is a worse confidentiality boundary: BlakPath can use it. That is accepted
because those records are the operator's own account system, not the client's
evidence.

`ENCRYPTION_MASTER_KEY` is the only field-encryption secret today. It is a
single process-wide value. #119 replaces its **role** for tenant data with the
tenant CMK. It must not remain a second unwrap path for tenant ciphertext.

## Failure modes

Fail closed for **that organisation only**. Never fall back to the platform
CMK, another tenant's CMK, or plaintext. Never queue the plaintext for a later
retry. Surface an error the tenant admin can act on, without the protected
value and without a key share.

| Failure                    | What KMS does                                                                                                                | What we do                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key disabled               | `KMSInvalidStateException` (key disabled or pending deletion).                                                               | Purge that organisation's data-key cache. Fail the request. Other tenants continue. Re-enabling the same CMK restores reads; we do not re-encrypt in between.                                    |
| Key deleted                | Pending deletion first (AWS minimum window 7 days), then `NotFoundException`.                                                | Same fail-closed behaviour while pending. After deletion the ciphertext is unreadable. Escrow can restore only through the release ceremony, into a **new** client CMK.                          |
| XKS proxy down             | Store disconnected (`CustomKeyStoreInvalidStateException`) or the cryptographic call fails because the proxy did not answer. | Treat as key unavailable. Do not switch the tenant to a BlakPath-managed CMK. Cache purge as above. Availability of one client's HSM is that client's availability.                              |
| KMS throttling             | `ThrottlingException`.                                                                                                       | Up to 3 retries with jitter inside the request, then fail. Do not skip encryption. Do not cache a throttle as a success. A throttle is not a reason to widen a grant.                            |
| Cross-account policy drift | `AccessDeniedException` after a policy or grant change.                                                                      | Same as disabled: purge cache, fail closed, alert with organisation id and key id only. Distinguish this from throttle in the log so an on-call engineer does not "fix" it by writing plaintext. |

A bug that catches these errors and writes the row in the clear is a defect,
not a degraded mode.

## Escrow

Escrow is optional. Default is no share held by BlakPath.

Native `AWS_KMS` keys cannot be exported, so there is nothing to escrow after
creation. XKS material stays in the client HSM; recovery is the client's HSM
backup, and BlakPath does not take a copy. Escrow is only the **imported**
path:

1. Generate the AES-256 key in a ceremony the tenant runs. BlakPath staff do
   not generate it on a laptop that later becomes the app host.
2. Split with Shamir **3 of 5**. The tenant nominates the custodians. BlakPath
   holds **at most one** share.
3. Import the key into the client CMK (`Origin=EXTERNAL`) and destroy the
   ceremony working copy. KMS will not give the material back. The shares are
   the only recovery.

A tenant may choose **zero** shares held by BlakPath (all five with people
they name). We then cannot help them recover. Say that before they choose.

Rejected: BlakPath holds a full duplicate of the key. One insider, or one
order aimed only at BlakPath, would read every escrowed tenant. That cancels
the point of a customer-held key.

### Threats

| Threat              | What goes wrong                                                               | What this decision does about it                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insider at BlakPath | Someone with production access reads tenant data, or takes the escrow copy.   | Tier 1 still lets the workload role decrypt while the grant lives. Escrow does not add a second full copy. One share is inert. The workload role cannot read the share store. Dual control on that store.                                                                    |
| Coercion            | A demand that BlakPath produce a client's key or data.                        | The live path is the client's grant: the client can retire it. The escrow path yields one share, not a key. This is not a promise about Australian law. Compulsion of the client custodians is outside our technical control. There is no override that bypasses the quorum. |
| Lost custodians     | Fewer than 3 shares remain. The key cannot be rebuilt. Data stays ciphertext. | Tell the tenant before they opt in. Succession is written down at the ceremony. A periodic check asks each custodian to confirm they still hold a share. That check must not reassemble the key.                                                                             |

### Release governance

1. **Consent first.** No share is deposited until the tenant has a recorded
   consent that names escrow, says BlakPath will hold one share, names who can
   take part in a release, and says that withdrawing consent destroys our
   share and can make recovery impossible. General application consent
   (`organisation_settings.consentWording`) is not this consent. The consent
   ledger is not built yet (`docs/privacy-architecture.md`). Until it exists,
   escrow cannot be turned on for a real tenant.
2. **Who may ask.** A tenant key administrator the tenant has already
   nominated, or a written legal instrument. A support ticket is not enough.
3. **Dual control.** Two named BlakPath custodians authorise release of our
   single share. The engineer with a production shell is not, alone, a
   custodian. Two BlakPath custodians still have only one share.
4. **Quorum.** At least three shares, assembled offline. Not on the app
   cluster, not in CI, not in a chat log.
5. **Where the key goes.** Import into a new CMK the client controls. Do not
   install the key into the BlakPath account. Do not leave the reconstructed
   key in the ceremony machine.
6. **Record.** Platform audit event with who asked, who authorised, and the
   new key id. No share, no key material, no personal data in the metadata.
7. **Tell the tenant** the release happened, unless a specific legal order
   forbids that notice. The order does not lower the share quorum.
8. **Withdrawing consent** destroys the BlakPath share. It does not disable
   the live CMK. Say both sentences in the consent.

#123 builds the ceremony and the store. This ADR does not add a service, a
table, or a secret.

## Regulatory notes

These are design constraints for engineers. They are not legal advice and not
a finding that BlakPath complies with any statute.

**APP 11 (Australian Privacy Principles).** APP 11.1 is the duty to take
reasonable steps to protect personal information from misuse, interference,
loss, and unauthorised access, modification or disclosure. A client-held CMK,
encryption in transit (TLS), and tenant isolation are the steps this design
relies on for tenant content. They are reasonable only if the failure modes
above fail closed and backups are ciphertext. APP 11.2 is destruction or
de-identification when the information is no longer needed. Crypto-shred
counts for ciphertext **only if** no plaintext remains in old backups, logs,
search indexes, replicas or heap dumps. Those copies are in scope of #122.
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
organisation can hold the means of access, see use (BYOK CloudTrail), and
revoke it. They do not decide Aboriginality, they do not authorise secondary
use, and they do not replace free, prior and informed governance by the
people the records are about. #43 is the governance work. This ADR does not
adopt a community protocol on anyone's behalf.

**Escrow needs explicit tenant consent.** A share held by the operator is a
copy of the means of access outside the tenant's sole control. That is
incompatible with the custody promise unless the tenant agrees, in a record
specific to escrow, after the loss and coercion consequences above have been
said in plain language. Consent is revocable. Revocation destroys the
operator's share. Do not infer escrow consent from a deed, a pilot agreement,
or the in-product consent wording.

## Consequences

- #119 implements the hierarchy, context, AAD and cache bounds, and removes
  any remaining comment that treats `ENCRYPTION_MASTER_KEY` as a KMS call.
- #120 migrates plaintext tenant columns and moves S3 off the single platform
  key. Pre-cutover backups are part of that migration's threat, not an
  afterthought.
- #121 is the client grant and XKS onboarding. Humans apply the IAM. This
  repo must not grow a path that applies it from CI against a real account
  without a separate reviewed change.
- #122 is disable, re-enable, rotate and shred, including backup destruction.
- #123 is escrow, blocked on the consent record.
- #124 is the Tier 2 spike. Until it lands, no document may say the server
  never sees a given class.
- #125 is the client-facing explanation. It has to match this ADR and must
  not call BlakPath-managed mode "your key".
- Certificate signing stays as it is.
- One compromised pod remains a Tier 1 residual risk. Say that in the trust
  pack. Do not paper over it with the memory wipe.

## Current implementation

Checked against the tree this ADR was written from. If code changes, update
this section in the same change. Do not leave it describing a future tree.

| Mechanism                          | Fact                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`            | Env var. Base64 of 32 bytes. `src/lib/env.ts` reads it. The app does not call KMS to obtain or wrap it.                                                              |
| `encryptField` / `decryptField`    | `src/lib/encryption/envelope.ts`. Local AES-256-GCM data key, wrapped by that env key. No AAD. No encryption context. Unit tests call it. No domain write path does. |
| TOTP and backup codes              | Better Auth 1.6 `symmetricEncrypt`: XChaCha20-Poly1305, key SHA-256(`BETTER_AUTH_SECRET`). Not the envelope helper and not KMS.                                      |
| Passwords                          | Argon2 via Better Auth.                                                                                                                                              |
| S3                                 | One `S3_KMS_KEY_ID` for production writes when `S3_ENDPOINT` is unset. Not per tenant.                                                                               |
| KMS in the app                     | `src/lib/kms/sign.ts` signs certificate payloads. `kms:Decrypt` appears in the example workload policy for S3, not for field encryption.                             |
| Redis                              | Ids and correlation ids.                                                                                                                                             |
| Logs                               | Pino denylist. Not a guarantee.                                                                                                                                      |
| Audit                              | Allowlist plus secret denylist. `ipAddress` and `userAgent` are stored. #80 open.                                                                                    |
| Search                             | No index on sensitive fields.                                                                                                                                        |
| Billing, BYOK, XKS, escrow, Tier 2 | Absent.                                                                                                                                                              |

## Not done in this ADR

Counsel still has to review the escrow agreement and the records clause
(#42). Community governance for Indigenous Data Sovereignty is #43. Per
council, a records officer has to authorise any future key destruction.
Deploying CMKs, grants and XKS is human work on top of #121. This document
does not apply infrastructure.
