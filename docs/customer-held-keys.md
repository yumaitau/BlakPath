# Customer-held keys: client trust pack

> **DRAFT. Not yet approved.** This trust pack is pending review by legal
> counsel and by a pilot council. Do not rely on it as a contractual statement
> until both reviews are recorded in the [review record](#review-record). The
> escrow ceremony and opt-in record exist in the application. The vault
> template is an example and is not deployed. The signed escrow agreement will
> govern if anything here differs from it.

This pack is for an organisation (a "client") that uses BlakPath and wants to
know who can read its records, how to cut off access, and how to check the
answers for itself. A summary is published at `/key-custody` in the
application. The settings page described here is **Settings → Encryption keys**
(`/settings/encryption-keys`).

BlakPath never determines Aboriginality. Keys protect records. They do not
change who decides anything: every outcome is still a recorded human act.

## 1. How your key protects records

- Each protected value is encrypted with its own random 256-bit data key
  (AES-256-GCM).
- That data key is wrapped by **your organisation's KMS key** with
  `GenerateDataKey`. Only the wrapped copy is stored. BlakPath must ask KMS to
  unwrap it (`Decrypt`) every time it is read, apart from a short in-memory
  cache (below).
- Every KMS call carries the encryption context `{org_id, purpose}`. `org_id`
  is your BlakPath organisation id. `purpose` is `field` for records,
  `blind-index` for search tokens, `key_validation` for the enrolment
  handshake, and `key_health` for the health check on the settings page. Your
  key policy can require your `org_id`, so your key can never be used for
  another organisation's data.
- The stored envelope names your key ARN and version, and is bound to its
  table, column, row and organisation. A value copied to another row or another
  organisation fails to decrypt.
- Unwrapped data keys stay in process memory for at most five minutes, then
  are zeroed. They are never written to disk, logs or backups.
- If KMS refuses your key, BlakPath **fails closed**: the request stops, the
  key is marked `unavailable`, the change is written to the audit trail, and
  staff see "Records are locked". There is no plaintext fallback and no second
  key.

### Coverage: what your key does and does not protect

These tenant records are sealed under your key: applicant name and intake,
family-link names and notes, form answers and respondent email, client contact
details and notes, application notes, decision rationale, consent wording, and
outbound correspondence held for delivery. Evidence, certificate, and export
objects use SSE-KMS with your key and S3 Bucket Keys off. A local development
store does not send those SSE headers.

These are **not** protected by your key:

| Data                                 | Protected by                                                |
| ------------------------------------ | ----------------------------------------------------------- |
| Database storage, snapshots, backups | BlakPath's platform storage encryption                      |
| Webhook signing secrets              | Platform envelope encryption, stored as ciphertext          |
| Audit trail metadata                 | Platform storage encryption; hash chain for tamper-evidence |
| Platform-owned settings and secrets  | The platform KMS key (`PLATFORM_KMS_KEY_ARN`)               |
| Bucket default encryption            | The platform S3 key, used only when an object has no tenant |

Revoking your key stops BlakPath opening the sealed records and the objects
written with your key. It does not make the items in this table unreadable.
Those are handled by tenant offboarding and retention instead (#42).

## 2. Custody modes

The mode is shown on Settings → Encryption keys.

| Mode                                                 | Where the key lives                                               | Who can disable it                         |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| **Managed by BlakPath** (`blakpath_managed`)         | A KMS key in BlakPath's AWS account, used only for you            | BlakPath, at your written request          |
| **Held by your organisation** (`client_owned`)       | A KMS key in your AWS account, or an external key store (XKS) key | You, at any time, without asking us        |
| **Held by you, with escrow** (`client_owned_escrow`) | As above, plus an escrow copy held by BlakPath (section 6)        | You; escrow release needs your signatories |

### Who can see what

"Plaintext" means readable record content.

| Party                                  | Managed by BlakPath                                                                                                                        | Held by your organisation (with or without escrow)                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your authorised staff**              | Plaintext, through BlakPath, limited by role and audited                                                                                   | Same                                                                                                                                               |
| **BlakPath application**               | Plaintext in memory while serving a permitted request                                                                                      | Same, **only while your key allows it**. Once you revoke, nothing under your key can be opened                                                     |
| **BlakPath staff**                     | No routine access. Production access is break-glass: time-boxed, approved by your organisation, audited and notified                       | Same, and break-glass cannot open records under a revoked key                                                                                      |
| **BlakPath key administrators**        | Can disable or schedule deletion of the key; cannot export AWS-generated key material                                                      | Cannot change your key or its policy. See the ARN, status, and the KMS calls BlakPath makes                                                        |
| **You (outside BlakPath)**             | Key ARN, status and history on the settings page. CloudTrail extract on request                                                            | Full control of the key policy. Every KMS call BlakPath makes appears in **your** CloudTrail                                                       |
| **AWS**                                | Runs KMS. AWS states that KMS key material is used only inside FIPS-validated hardware security modules and is not exportable in plaintext | Same. With XKS, the key material stays in your external key manager outside AWS                                                                    |
| **Escrow officers** (escrow mode only) | n/a                                                                                                                                        | No access in normal operation. Two officers together can unwrap the escrow copy only under the release procedure, inside an isolated vault account |

A customer-held key is a **control and a record**, not end-to-end encryption.
While your key is enabled, BlakPath's application reads plaintext in memory to
serve your staff. What you gain is the ability to stop that at any time, and an
independent log of every use that BlakPath cannot edit.

## 3. How to revoke

Any of these, in your AWS account, revokes BlakPath's access:

1. **Disable the key** (`DisableKey`). Reversible.
2. **Remove BlakPath's statement** from the key policy, or revoke the grant.
   Reversible by restoring it.
3. **Disconnect the external key store** (XKS only). Reversible.
4. **Schedule key deletion** (7 to 30 days). Cancellable until the date passes;
   after that it is permanent. See section 5.

For a key managed by BlakPath, send a written request from an authorised
signatory to BlakPath support. BlakPath disables the key and records the change.

## 4. What happens when you revoke

- BlakPath's next KMS call for your organisation is refused. Data keys already
  in memory expire within **five minutes**, so within five minutes nothing
  under your key can be read or written.
- The key status becomes `unavailable` (or `disabled` / `pending_deletion` when
  BlakPath records that state). The change is written to the platform audit
  trail with the KMS error name.
- Staff in your organisation see "Records are locked". Encrypted records are
  not shown, partly or under another key. API calls return HTTP 423 or 503 with
  code `TENANT_KEY_UNAVAILABLE`.
- Nothing is deleted. Other organisations are unaffected.
- Organisation administrators can still sign in and open Settings →
  Encryption keys, which shows status and history but no records.
- **To restore**: re-enable the key (or restore the policy statement), then
  choose **Check and restore access** on Settings → Encryption keys. A passing
  check returns the key to `active`. A key BlakPath recorded as `disabled` or
  `pending_deletion` is returned to `active` only by a recorded BlakPath
  change.

## 5. Crypto-shredding, including backups

Deleting your key makes every value wrapped by it permanently unreadable.

- **Backups are covered.** Database backups, snapshots, replicas and exports
  hold only wrapped data keys and ciphertext for protected fields. Once the key
  is deleted, those copies cannot be decrypted by anyone, including BlakPath
  and AWS. No backup has to be found or edited.
- **AWS-generated key material** cannot be exported, so deletion is final.
- **Imported key material** (`Origin=EXTERNAL`): deletion is final only when
  every copy you hold is also destroyed. In escrow mode, the escrow copy must be
  destroyed too (section 6); BlakPath confirms that destruction in writing.
- **External key store**: deletion is final when your key manager destroys the
  key.
- **Not shredded**: the data listed under "not protected by your key" in
  section 1, any file or export already downloaded in plaintext, and the audit
  trail (which holds metadata, not record content). Those are removed by tenant
  offboarding and backup expiry (#42).
- KMS enforces a 7-to-30-day waiting period before deletion. Use it to confirm
  you hold no records you still need.

## 6. Escrow terms summary

Escrow is optional and opt-in. This summary is a draft; the escrow agreement
(#42) and the escrow service design (#123) govern.

- **What can be escrowed**: key material you import into your KMS key
  (`Origin=EXTERNAL`). Key material that AWS generates cannot be exported, so
  it cannot be escrowed.
- **How it is held**: the material is encrypted to BlakPath's escrow public key,
  optionally split M-of-N across custodians you nominate (for example, board
  members or Elders). It is stored in a separate AWS account with write-once
  storage. The BlakPath application and its workload roles have no access.
- **Release**: only on a written request from your registered authorised
  signatories, after identity verification and a cooling-off period with notice
  to all your registered contacts. Two BlakPath escrow officers act together.
  The material is re-imported into a **new** key in your account, then rotated.
  Every step is audited and reported to you.
- **Drill**: an annual recovery drill using a synthetic key.
- **Withdrawal**: you can leave escrow and require written confirmation that
  the escrow copy is destroyed.
- **On the settings page**: escrow status, and custodian names only once
  enrolment records them. No contact details or key shares are shown.

## 7. Verification steps for a council auditor

These steps let an auditor confirm that **their key** protects **their data**,
without trusting BlakPath's word. Steps 2 to 6 need read access to the client's
AWS account (`kms:GetKeyPolicy`, `kms:DescribeKey`,
`cloudtrail:LookupEvents`). Use a staging organisation for step 6.

1. **Read the key on the settings page.** An organisation administrator opens
   Settings → Encryption keys (a recent sign-in is required). Record the custody
   mode, key ARN, AWS account, version, status, the organisation id shown under
   "Key usage in CloudTrail", and the key change history.
   _Expected_: the ARN is a key in the client's account (or, for
   `blakpath_managed`, BlakPath's account).
2. **Confirm the key is the client's.** Run
   `aws kms describe-key --key-id <ARN>`.
   _Expected_: `KeyManager` is `CUSTOMER`, `KeyState` is `Enabled`, the account
   is the client's, and `Origin` is `AWS_KMS`, `EXTERNAL` or
   `EXTERNAL_KEY_STORE` as agreed.
3. **Confirm BlakPath's access is narrow.** Run
   `aws kms get-key-policy --key-id <ARN> --policy-name default`.
   _Expected_: BlakPath's principals may only call `kms:GenerateDataKey` and
   `kms:Decrypt`, and only when `kms:EncryptionContext:org_id` equals the
   client's organisation id (template below). No `kms:PutKeyPolicy`,
   `kms:ScheduleKeyDeletion` or `kms:CreateGrant` for BlakPath.
4. **Trigger and observe a health check.** Choose **Check key now** on the
   settings page, then run the command shown under "Key usage in CloudTrail"
   (CloudTrail can take several minutes to show a new event).
   _Expected_: a `GenerateDataKey` and a `Decrypt` event, called by BlakPath's
   workload role, with `org_id` set to the client's organisation id and
   `purpose` set to `key_health`. The page shows the check in its history.
5. **Confirm records use the key.** In the same output, look for events with
   `purpose` `field` after staff have created or opened a record covered by the
   coverage list.
   _Expected_: every such event carries the client's `org_id`. No event for
   another organisation id appears on the client's key.
6. **Revoke and restore (staging).** Disable the key, then choose **Check key
   now** (or wait five minutes and open a record on the coverage list).
   _Expected_: the check fails with `DisabledException`; the settings page
   shows `unavailable`; the history shows "KMS refused the key
   (DisabledException)"; staff pages show "Records are locked" and display no
   records. Re-enable the key and choose **Check and restore access**.
   _Expected_: the check passes, status returns to `active`, the workspace
   opens again, and every step appears in the history and in CloudTrail.
7. **Cross-check history.** Compare the settings-page history with the
   client's CloudTrail for the same period.
   _Expected_: every `unavailable` event lines up with a refused KMS call, and
   every passed check lines up with a successful pair of KMS calls.

Record the date, auditor, organisation, ARN and the result of each step.

### Key policy statement template

Add this statement to the client key's policy. Replace the placeholders with
values from BlakPath onboarding.

```json
{
  "Sid": "BlakPathUseForOneOrganisation",
  "Effect": "Allow",
  "Principal": {
    "AWS": [
      "arn:aws:iam::<BLAKPATH_ACCOUNT_ID>:role/<BLAKPATH_WEB_TASK_ROLE>",
      "arn:aws:iam::<BLAKPATH_ACCOUNT_ID>:role/<BLAKPATH_WORKER_TASK_ROLE>"
    ]
  },
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "kms:EncryptionContext:org_id": "<YOUR_BLAKPATH_ORGANISATION_ID>",
      "kms:EncryptionContext:purpose": ["field", "key_health"]
    }
  }
}
```

The matching BlakPath-side permission is the `TenantEnvelopeKeys` statement in
`infra/aws/workload-roles.example.yaml`.

## 8. Related documents and open items

- **Privacy policy (#40)**: the public privacy page links to the key custody
  summary. The full policy must describe key custody in the same terms as this
  pack.
- **Sub-processor register (#42)**: AWS KMS (ap-southeast-2) is a
  sub-processor for every custody mode. In client-held modes the client's own
  AWS account is not a BlakPath sub-processor. The escrow vault account is a
  BlakPath-operated system.
- **Penetration test scope (#45)**: must include the encryption-keys settings
  page and its health-check endpoint, tenant isolation of key use (encryption
  context and AAD), the fail-closed path, and the escrow vault and release
  procedure once built.
- Technical detail: [`privacy-architecture.md`](privacy-architecture.md),
  [`threat-model.md`](threat-model.md).

## Review record

| Review                   | Reviewer | Date | Outcome |
| ------------------------ | -------- | ---- | ------- |
| Legal counsel            | Pending  |      |         |
| Pilot council            | Pending  |      |         |
| Auditor walkthrough (§7) | Pending  |      |         |
