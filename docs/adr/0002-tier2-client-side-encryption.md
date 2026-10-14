# ADR 0002: Tier 2 client-side encryption (addendum to ADR 0001)

- **Status:** Proposed. **Pending endorsement by the data governance group
  (#43).** This ADR is a design-spike outcome. It is not accepted, and nothing
  here may be built into a production path, until the governance group has
  endorsed the eligible data classes and the trade-offs below. The endorsement
  is a recorded human decision. Engineers do not decide it.
- **Date:** 2026-10-14
- **Addendum to:** [ADR 0001: Customer-held keys](0001-customer-held-keys.md)
  (#118). ADR 0001 decides Tier 1 and names Tier 2 as later work. This ADR
  designs Tier 2.
- **Relates to:** #117 (epic), #124 (this spike), #123 (escrow), #43
  (Indigenous Data Sovereignty and governance), #45 (pentest), #42 (contracts).
- **Prototype:** `src/lib/encryption/tier2-prototype.ts`, tests in
  `tests/unit/tier2-prototype.test.ts`. Not wired into the app.

> **BlakPath never determines Aboriginality.** Tier 2 changes who can read
> some text. It does not score, rank, predict, infer, auto-approve or
> auto-reject identity. A note the server cannot read is still only ever read
> and weighed by authorised humans, and outcomes stay recorded human acts.

## Context

ADR 0001 Tier 1 encrypts tenant data under a tenant-controlled KMS key. The
server still decrypts in memory while it handles a request. That keeps search,
malware scanning, certificates, exports and email working. It also means the
operator, a compromised app pod, or anyone who can read process memory can
read Tier 1 plaintext while the tenant's key is enabled.

Some communities may require that specific information is never visible to
the server at all, even in memory. The examples raised are genealogy notes and
culturally restricted material. Tier 2 is for those classes only.

## Decision

For a small, named set of text data classes that a tenant opts into, the
browser encrypts before upload and decrypts after download. The server stores
and serves ciphertext. It never receives the keys that open it.

1. Each organisation that opts in has an **organisation key pair** (ECDH
   P-256). The public key is stored on the server and anyone in the
   organisation's workflow can encrypt to it. The private key is only ever
   stored sealed to a staff member's public key, or to the escrow key (#123).
2. Each staff member who may read Tier 2 data has a **staff key pair** (ECDH
   P-256). Its private key is stored on the server wrapped under a **staff
   key-encryption key (KEK)**. The KEK is derived in the browser from the
   WebAuthn **PRF** extension on a passkey (preferred), or from a **Tier 2
   passphrase** (fallback).
3. A Tier 2 value is **sealed to the organisation public key**: ephemeral
   ECDH, HKDF-SHA-256, then AES-256-GCM with AAD that binds it to its
   organisation, purpose, record and key version.
4. A **leaver** is revoked by **rotating** the organisation key, not only by
   deleting their grant. See [Leaver](#leaver).
5. Tier 2 is **WebCrypto only**. No bespoke primitives, no third-party crypto
   library, no server-side fallback that decrypts.
6. A Tier 2 class gives up server search, server malware scanning, and
   inclusion in certificates, exports and email bodies. These losses are
   deliberate and are listed per class below. The governance group endorses
   them, class by class.
7. Tier 2 sits on top of Tier 1. The tenant's other data stays in its Tier 1
   custody mode. The ciphertext rows themselves are also stored under Tier 1,
   so a Tier 2 value is encrypted twice at rest.

## What Tier 2 protects against, and what it does not

For Tier 2 classes, the **server is the adversary**: the operator, AWS, a
compromised pod, a database or backup thief, and a lawful demand served on
BlakPath. All of them get ciphertext only.

Tier 2 does **not** protect against:

- **Malicious code served to the browser.** BlakPath serves the JavaScript
  that does the encryption. A compromised build, a compromised deploy, a
  hostile operator or an injected script can read plaintext in the page.
  Tier 2 moves trust from "the server at rest and in memory" to "the code the
  server delivers". That is a real gain, because the second is smaller,
  reviewable and visible in the client. It is not zero trust. The
  [CSP and supply-chain requirements](#csp-and-supply-chain) exist to shrink
  this gap. Nothing closes it fully in a web app.
- **Key substitution when granting access.** If the server lies about a
  joiner's public key, the granting admin seals the organisation key to the
  attacker. Mitigation: show a public-key fingerprint to both staff members
  and compare it in person or by phone before the first grant.
- **A compromised staff device**, browser extension, or screen capture.
- **What a person has already read.** A leaver can have copied plaintext or
  keys before leaving. Rotation stops new access. It cannot take back old
  access. That is an employment, contract and cultural-authority matter.
- **Metadata.** The server still knows which record has a Tier 2 note, its
  size, who wrote it, when, and who fetched it.

| Party                             | Tier 1 (ADR 0001)                          | Tier 2 class                                                   |
| --------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| BlakPath operator                 | Can read through the running app           | Ciphertext only                                                |
| AWS                               | Per custody mode                           | Ciphertext only                                                |
| Compromised app pod               | Plaintext in memory                        | Ciphertext only, unless it can change the code sent to clients |
| Database or backup thief          | Ciphertext under the tenant key            | Ciphertext under the tenant key, then under the org key        |
| Staff member with a grant         | App RBAC                                   | App RBAC **and** an unlocked staff key                         |
| Staff member without a grant      | App RBAC                                   | Nothing, even with RBAC permission                             |
| Leaver after rotation             | Nothing, once their session ends           | Nothing held by the server. Copies they made are out of reach. |
| Applicant                         | Their own shared data, per app permissions | Nothing. Applicants do not hold the org key.                   |
| Escrow custodians acting together | Per ADR 0001 escrow                        | The org private key, under the release governance of #123      |

## Primitives

| Use                          | Primitive (WebCrypto)                           | Notes                                                                                                          |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Org and staff key pairs      | ECDH P-256                                      | Supported in every target browser and in Node. X25519 can replace it later with a format version bump.         |
| Sealing to a public key      | ECDH + HKDF-SHA-256 + AES-256-GCM               | Ephemeral key per seal. HKDF salt is both public keys. HKDF info names the purpose and format version.         |
| Value encryption             | AES-256-GCM, 96-bit random IV, 128-bit tag      | AAD is canonical JSON: `org_id`, `purpose`, `record_id`, `key_version`, `v`.                                   |
| Staff KEK from a passkey     | WebAuthn PRF output → HKDF-SHA-256 → AES-GCM    | Salt is the org id. Info includes the user id. One wrap per enrolled passkey, because each yields its own PRF. |
| Staff KEK from a passphrase  | PBKDF2-HMAC-SHA-256, 600,000 iterations minimum | WebCrypto has no Argon2. Random 16-byte salt per staff member. The code refuses fewer iterations.              |
| Staff private key at rest    | AES-GCM `wrapKey` (PKCS#8) under the staff KEK  | AAD binds org id and user id, so a wrapped key cannot be replayed as another user's.                           |
| Fingerprint for verification | SHA-256 of the SPKI                             | Shown in the UI for out-of-band comparison.                                                                    |

The composition, ECIES-style sealing, is ours. Each piece is standard, but the
composition still needs independent cryptographic review before production.
Add it to the #45 pentest scope.

Keys unlocked for reading are imported **non-extractable**. Only the joiner,
rotation and escrow-deposit flows open the organisation private key as
extractable, and only for the duration of that flow. Zeroing a byte array in
JavaScript is hygiene, not a boundary.

## Key hierarchy

```text
Tier 1 tenant root CMK (ADR 0001)
  encrypts the database rows that hold Tier 2 ciphertext, like any other row

Tier 2, per opted-in organisation
  org key pair vN (ECDH P-256)
    public key: on the server, used by browsers to seal values
    private key: sealed to each granted staff public key, and to the escrow key
      staff key pair (ECDH P-256), one per staff member
        public key: on the server, with a fingerprint
        private key: wrapped under the staff KEK
          staff KEK: from a passkey PRF output, or a Tier 2 passphrase
  Tier 2 value: sealed to org public key vN, AAD binds org, purpose, record, vN
```

The Tier 2 passphrase must **not** be the account password. Better Auth
receives the account password at sign-in, so a key derived from it would be
derivable by the server.

## Staff flows

### Enrolment

The staff member chooses a passkey with PRF support, or sets a Tier 2
passphrase. The browser generates the staff key pair, wraps the private key
under the KEK, and uploads the wrapped key and the public key. PRF support
varies by browser, operating system and authenticator. Detect it at
enrolment and offer the passphrase path when it is missing. Encourage two
unlock methods (for example, a passkey and a written-down passphrase kept as
the organisation's policy directs) so that one lost device is not a lockout.

### Joiner

An existing staff member with the grant permission:

1. compares the joiner's key fingerprint with the joiner, out of band;
2. unlocks, opens the organisation private key as extractable;
3. seals it to the joiner's public key and uploads the grant.

The server records the grant as an audited human act. It cannot check the
fingerprint comparison happened. The UI must make skipping it harder than
doing it.

### Leaver

Deleting the leaver's grant stops the server serving them the sealed key. It
does not revoke a key they already opened. So a leaver triggers a rotation,
run in a remaining admin's browser:

1. generate organisation key pair vN+1;
2. seal its private key to every remaining staff member, and to the escrow key;
3. open each Tier 2 value under vN and re-seal it under vN+1;
4. upload the new grants and values, then delete every vN grant and vN value.

The prototype re-seals eagerly. For a tenant with many values, production
needs a resumable job that runs in the browser, survives a closed tab, and
does not leave a value readable only under vN. Until rotation finishes, new
writes use vN+1 and reads accept both versions. Removal of the leaver's
access in the app (RBAC, session revocation) happens first and immediately.

Old vN ciphertext in backups remains openable by anyone who kept the vN key
until those backups expire. Backup retention is the bound on that exposure.

### Lost passkey or forgotten passphrase

Another granted staff member re-grants the organisation key to the person's
new staff key, after the fingerprint check. If **every** granted staff member
is locked out, recovery is only through escrow (#123). Without escrow the data
is gone. That is the honest trade, and onboarding must say so in plain words.

## Escrow

Escrow of the organisation private key reuses #123 and ADR 0001's escrow
model. The escrow party holds an escrow key pair whose private key is
generated offline and split M-of-N (3-of-5 in ADR 0001, BlakPath holding at
most one share). Every organisation key version is sealed to the escrow public
key alongside the staff grants. Release follows ADR 0001's release governance
and needs the tenant's explicit, escrow-specific consent recorded first. A
tenant may decline escrow and accept the lockout risk. The governance group
should say whether declining is allowed for each class.

## Eligible data classes

Eligibility test: the value is text; the server does not need its content for
any workflow step, certificate, export, notification, scan, search or report;
and the community has asked for it.

| Class                                                              | Where today                                               | Eligible?                    | Why                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Genealogy notes on a family link                                   | `family_links.notes`                                      | **Yes, proposed**            | Free text staff read. No workflow step reads its content.                                      |
| Culturally restricted staff notes on an application                | New. `application_notes` with a restricted visibility     | **Yes, proposed**            | Staff-only text. Never shared with the applicant, never in a certificate.                      |
| Culturally restricted text attachments                             | New                                                       | **Yes, proposed, text only** | Plain text (UTF-8) only, size-capped and validated in the browser. See malware scanning below. |
| Family-link relationship, relative name, community                 | `family_links.relationship`, `relative_name`, `community` | No                           | Shown across review screens and decisions, and part of the record a decision rests on. Tier 1. |
| Decision notes and outcomes                                        | `family_links.decision_note`, decisions                   | No                           | The recorded human act must be auditable, appealable and exportable. Tier 1.                   |
| Identity evidence files (PDF, images)                              | S3 evidence                                               | No                           | Must be malware-scanned on the server before anyone opens them. Tier 1.                        |
| Applicant-shared notes                                             | `application_notes` shared visibility                     | No                           | Applicants do not hold the org key.                                                            |
| Certificates, exports, email bodies, audit metadata, auth, billing | various                                                   | No                           | Server-generated or server-needed. Audit metadata holds no PII anyway (#80).                   |

### What each eligible class loses

| Loss                                  | Effect                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No server search                      | Not in any search index or blind index. A staff member can search only the values already decrypted on their screen.                                                                                                                                                                      |
| No server malware scan                | Text only. The browser checks the type is UTF-8 text with no control characters beyond whitespace and enforces a size cap before sealing. It is rendered as plain text, never as HTML or a file download, so fail-secure holds without a scan. No PDFs, images or Office files in Tier 2. |
| Not in certificates, exports or email | Exports show "Restricted note, open in BlakPath". Emails say a note exists, never its content. Certificates never include it.                                                                                                                                                             |
| No server-side validation of content  | Length, emptiness and format checks run in the browser. The server checks only the ciphertext shape and size.                                                                                                                                                                             |
| No AI or automated processing         | Already true for all data. Tier 2 makes it physically impossible on the server.                                                                                                                                                                                                           |
| Access requests and legal demands     | BlakPath can produce ciphertext and metadata only. A tenant staff member must decrypt for an APP 12 access request. The tenant answers demands for content.                                                                                                                               |
| Audit is "ciphertext served to X"     | The server can log who fetched a value, not whether they decrypted it.                                                                                                                                                                                                                    |
| Data lost if all keys are lost        | Without escrow there is no recovery.                                                                                                                                                                                                                                                      |

## CSP and supply chain

The pages that unlock keys or show Tier 2 plaintext must meet these
requirements before Tier 2 ships. They are requirements, not a statement of
the current header set.

- Nonce-based `script-src` with `'strict-dynamic'`. No `'unsafe-inline'`, no
  `'unsafe-eval'`. No third-party script origins. `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, and a
  `connect-src` limited to BlakPath's own origin.
- Trusted Types (`require-trusted-types-for 'script'`) on those routes.
  Decrypted text is rendered as text, never through `dangerouslySetInnerHTML`.
- No analytics, session replay, error-reporting SDK or chat widget on those
  routes, because each can read the page.
- The Tier 2 crypto module has zero runtime dependencies and imports only
  `globalThis.crypto.subtle`. A lint rule (follow-up) enforces it.
- Frozen lockfile, dependency review on every change, and build provenance for
  the deployed bundle. Publish the hash of the Tier 2 module per release so a
  tenant can check what their browsers ran.
- Unlocked keys live in memory only: never `localStorage`, `sessionStorage` or
  IndexedDB in unwrapped form. Lock after 15 minutes idle and on sign-out.

## UX for non-technical staff

- A lock icon and the words **"Restricted: only your organisation's staff can
  read this. BlakPath cannot."** on every Tier 2 field, in edit and in view.
- One **Unlock restricted notes** prompt per session, using the passkey the
  person already signs in with where PRF works.
- When locked, show that a note exists and who wrote it, with an unlock
  button. Never show an error that looks like data loss.
- A plain-language recovery card at enrolment: "If you lose your passkey,
  another staff member can let you back in. If everyone loses theirs, only
  escrow can recover these notes. Without escrow they are gone for good."
- Fingerprint comparison for joiners is a short word list or number groups,
  read aloud, not a hex string.
- Accessibility follows `docs/accessibility-acceptance.md`.

## The prototype

`src/lib/encryption/tier2-prototype.ts` shows, with WebCrypto only:

- a genealogy note sealed by one staff member and opened by another, one
  unlocking with a simulated passkey PRF output and one with a passphrase;
- server-side shapes that contain no plaintext;
- non-extractable keys in read sessions;
- AAD binding: moving a note to another record, tenant or key version fails;
- a joiner grant;
- leaver revocation by rotation: the leaver's retained v1 key opens nothing
  the server holds after rotation, including notes written afterwards.

It does not show a real WebAuthn PRF ceremony, persistence, a resumable
rotation job, escrow, or any UI. Those are the follow-up issues.

## Open questions for the governance group (#43)

1. Which classes are in Tier 2, and is it per tenant opt-in or mandatory for
   some classes?
2. Is the loss of each capability above acceptable for each class?
3. Is declining escrow allowed, given that it means permanent loss if all
   staff keys are lost?
4. Who in a tenant may grant Tier 2 access, and must a cultural authority
   approve grants for culturally restricted material?
5. Should culturally restricted material be readable by a narrower group than
   all granted staff? That needs per-group keys and is not in this design.

## Consequences

- A tenant can hold specific text that BlakPath cannot read even while
  serving it. The security of that text then depends on the code BlakPath
  ships to the browser, which needs its own controls.
- Staff gain an unlock step and a recovery responsibility.
- Rotation on every leaver is browser work proportional to the number of
  Tier 2 values. Keeping the classes small keeps this cheap.
- Tier 2 adds no server-side KMS calls. Tier 1 still applies to the rows
  that hold the ciphertext.
