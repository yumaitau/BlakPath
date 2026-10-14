# Key escrow runbook

Escrow is an **optional, opt-in** service for clients that own their tenant key.
BlakPath holds a recoverable copy of the client's key material under dual
control, and releases it only on the client's written, verified request. The
client can withdraw at any time.

Escrow never touches records about people. It only concerns key custody.

## Scope

- **Can be escrowed:** client KMS keys with imported key material
  (`Origin=EXTERNAL`, custody mode `client_owned_escrow`) and, later, Tier 2
  organisation keys.
- **Cannot be escrowed:** KMS-generated material (`blakpath_managed`, or a
  `client_owned` key created by KMS). AWS never exports it. Say this clearly at
  onboarding.
- Escrow is recorded per tenant in `organisation_keys` (`escrow`,
  `escrow_consent_reference`, `escrow_consented_at`, `escrow_package_digest`).
  The database refuses `escrow = true` without all three. Changes are on the
  platform audit chain (`key.escrow_opted_in`, `key.escrow_withdrawn`).

## Roles

| Role                          | Who                                         | Can                                                        |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Client authorised signatories | Registered in the escrow agreement (#42)    | Sign consent; request a release; object during cooling-off |
| Custodians (Shamir split)     | Nominated by the client, e.g. board, Elders | Keep one sealed share each; present it for a release       |
| Ceremony lead                 | BlakPath                                    | Runs the offline ceremony                                  |
| Escrow officer A              | BlakPath, named person                      | Enable/disable the escrow key; read deposited packages     |
| Escrow officer B              | BlakPath, different named person            | Decrypt sealed items with the escrow key                   |
| Governance                    | Community oversight (#43)                   | Receives every release and drill report                    |

Officer A cannot decrypt. Officer B cannot enable the key or read packages. A
release needs both, plus the client's signatories, plus M custodians when the
material is split.

## Cryptography

All operations use `node:crypto` or one audited library. Nothing is implemented
in this repository.

- **Key material:** 32 bytes from the OS CSPRNG (`crypto.randomBytes`).
- **KMS import:** `RSAES_OAEP_SHA_256` with the wrapping public key from
  `GetParametersForImport` (RSA-3072 or RSA-4096; RSA-2048 is refused).
- **Escrow seal:** the same algorithm with the vault's RSA-4096 KMS key, so
  only `kms:Decrypt` inside the vault can open a sealed item. The private key
  never leaves KMS.
- **Shamir M-of-N:** [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing)
  (Privy, GF(256), zero dependencies, independently audited by Cure53 and
  Zellic, pinned to `0.0.4`). It was chosen over an in-repo implementation
  because an audited, single-purpose library is less risky than new field
  arithmetic here. Its use is isolated to `src/lib/key-ceremony/escrow.ts`.
  The tests reconstruct from every M-subset and fail with M-1.
- **Key check value:** HMAC-SHA-256 keyed by the material over a fixed label.
  It confirms that recovered material is right, and it reveals nothing about
  the material. Shamir shares have no integrity of their own, so recovery
  always checks this value.
- **Package binding:** each sealed plaintext is `BPEK || packageId || payload`,
  so items from different packages cannot be mixed.

With a split, the vault keeps only the manifest. Each custodian keeps one share
sealed to the escrow key. So custodians cannot recover without the vault, and
the vault cannot recover without M custodians.

## 1. Vault provisioning (once)

1. Create a dedicated escrow account in AWS Organizations. It must not run
   workloads and must not trust the workload account.
2. Deploy [`infra/aws/escrow-vault.example.yaml`](../infra/aws/escrow-vault.example.yaml)
   in that account in `ap-southeast-2`, after review. Officers are IAM users in
   the vault account with hardware MFA. Do not use shared credentials.
3. Officer A exports the public key, records its SHA-256 and disables the key:

   ```sh
   aws kms get-public-key --key-id alias/blakpath-escrow \
     --query PublicKey --output text > blakpath-escrow-public-key.b64
   base64 --decode < blakpath-escrow-public-key.b64 | shasum -a 256
   aws kms disable-key --key-id alias/blakpath-escrow
   ```

   Publish the public key and its fingerprint in the escrow agreement. Every
   ceremony transcript must show the same fingerprint.

4. Access Analyzer evidence: the account analyzer `blakpath-escrow-vault` must
   show **no active findings** for the escrow key and buckets. Export the
   findings list (empty) and attach it to the provisioning record. Repeat
   before every release and drill.
5. Recommended Organizations SCP on the escrow account: deny
   `kms:ScheduleKeyDeletion`, `kms:PutKeyPolicy`, `s3:PutBucketPolicy`,
   `cloudtrail:StopLogging` and `organizations:LeaveOrganization` except for a
   break-glass role that needs management-account approval.

The workload roles in `infra/aws/workload-roles.example.yaml` allow
`kms:Decrypt` on `*` with an encryption-context condition. That does not reach
the vault: a cross-account key also needs its key policy to allow the caller,
and the escrow key policy denies every principal outside the vault account. A
second deny names the workload account.

## 2. Key ceremony (onboarding)

Before you start:

- The escrow agreement and consent are signed by the client's authorised
  signatories. Note the consent reference (contract or e-signature id).
- Signatories and contacts are registered. With a split, custodians and the
  threshold M are recorded in the agreement. Manifests use role labels
  (`Chairperson`, `Elder A`), not personal details.
- In the client account, the client (or BlakPath with the client present)
  creates the target key and downloads the import parameters:

  ```sh
  aws kms create-key --origin EXTERNAL --description "BlakPath tenant key"
  aws kms get-parameters-for-import --key-id <key-id> \
    --wrapping-algorithm RSAES_OAEP_SHA_256 --wrapping-key-spec RSA_4096 \
    --output json > import-parameters.json
  jq -r .PublicKey import-parameters.json > wrapping-public-key.b64
  jq -r .ImportToken import-parameters.json | base64 --decode > ImportToken.bin
  ```

  Each call returns a new public key and token pair. Use both from the same
  call. They expire after 24 hours.

On the offline machine (booted from verified media, network disabled, repository
at a tagged commit with dependencies installed beforehand):

```sh
pnpm key-ceremony generate \
  --organisation-id <organisation uuid> \
  --target-key-arn <client key ARN> \
  --kms-wrapping-key wrapping-public-key.b64 \
  --escrow-public-key blakpath-escrow-public-key.b64 \
  --custodian "Chairperson" --custodian "Elder A" --custodian "Elder B" \
  --threshold 2 \
  --out ./ceremony
```

Omit `--custodian`/`--threshold` to seal the whole material to the vault. The
tool writes, with mode `0600`:

| File                         | Goes to                                       |
| ---------------------------- | --------------------------------------------- |
| `EncryptedKeyMaterial.bin`   | Client KMS import                             |
| `escrow-package.json`        | Vault (manifest; digest recorded in BlakPath) |
| `escrow-sealed-material.bin` | Vault (whole mode only)                       |
| `custodian-share-NN.bin`     | One custodian each (split mode only)          |
| `ceremony-transcript.md`     | Printed, completed and signed; scan to vault  |

Plaintext material is never written to disk. Witnesses compare the escrow
public key and wrapping key fingerprints printed in the transcript.

Then, online:

1. Import into the client key:

   ```sh
   aws kms import-key-material --key-id <key-id> \
     --encrypted-key-material fileb://EncryptedKeyMaterial.bin \
     --import-token fileb://ImportToken.bin \
     --expiration-model KEY_MATERIAL_DOES_NOT_EXPIRE
   ```

2. Deposit to the vault with the deposit role, under
   `tenants/<organisation id>/<package id>/`: the manifest, the signed
   transcript scan and, in whole mode, the sealed material. Object Lock
   (compliance mode) makes them immutable for the retention period.
3. Give each custodian their sealed share on separate media in a tamper-evident
   envelope. Each custodian initials the transcript.
4. Anyone can check files without secrets:
   `pnpm key-ceremony verify --package escrow-package.json [--file share.bin]`.
5. Register the key in BlakPath with custody mode `client_owned_escrow`, then
   record the opt-in with `recordEscrowOptIn` (consent reference, signing
   date, package digest printed by the tool, recording user). The "Your keys"
   page (#125) shows the status.
6. Wipe the offline machine and destroy temporary media.

## 3. Release procedure

Each step is logged in the vault trail and sent to the escrow activity topic.
Tell the client's registered contacts at **every** numbered step, and record
when you did.

1. **Written request** from the number of authorised signatories the agreement
   requires. Check names and signatures against the register.
2. **Identity verification.** Call back each signatory on the registered number
   (not one given in the request) and verify identity by video or in person.
3. **Notice and cooling-off.** Notify all registered contacts and the
   custodians. Wait the agreed period (default 5 business days). Any registered
   contact can object; an objection halts the release and goes to governance.
4. **New client key.** The client creates a **new** `Origin=EXTERNAL` key and
   downloads its wrapping public key and import token. Never re-import into the
   old key.
5. **Dual-control session** on the dedicated release workstation. Opened items
   go only to a RAM disk.
   1. Officer A assumes `blakpath-escrow-officer-a`, confirms Access Analyzer
      has no active findings, and enables the escrow key.
   2. Officer A retrieves the package (and sealed material in whole mode).
      With a split, M custodians present their sealed shares in person.
   3. Officer B assumes `blakpath-escrow-officer-b` and opens each item:

      ```sh
      aws kms decrypt --key-id alias/blakpath-escrow \
        --encryption-algorithm RSAES_OAEP_SHA_256 \
        --ciphertext-blob fileb://custodian-share-01.bin \
        --query Plaintext --output text | base64 --decode > /ramdisk/opened-01.bin
      ```

   4. Rebuild and wrap for the new key:

      ```sh
      pnpm key-ceremony recover --package escrow-package.json \
        --opened /ramdisk/opened-01.bin --opened /ramdisk/opened-03.bin \
        --kms-wrapping-key new-wrapping-public-key.b64 --out ./release
      ```

      The tool refuses fewer than M shares and any result whose check value
      does not match.

   5. Officer A disables the escrow key. Destroy the RAM disk.

6. **Import** `release/EncryptedKeyMaterial.bin` into the new key. BlakPath
   rotates the tenant to the new key ARN (`rotateOrganisationKey`). This
   clears the escrow flag, because the old package is now spent.
7. **Rotate.** The released material has been outside KMS. The client moves to
   fresh material (a new ceremony) and re-wraps data keys. If they stay in
   escrow, record a new opt-in for the new package.
8. **Report** to the client and governance: request, verification, notices,
   session times, CloudTrail event ids, `recovery-report.json` and the signed
   transcripts.

## 4. Withdrawal

The client's signatories can withdraw by written notice. Record it with
`withdrawEscrow` (reason and recording user). Object Lock stops the vault
package being deleted before its retention ends. So pair a withdrawal with a
rotation to new, un-escrowed material: the old package then opens nothing. It
is deleted when retention ends. State this in the consent wording.

## 5. Annual recovery drill

Once a year per escrow tenant, in staging:

1. Run a ceremony with `--drill` against a staging `Origin=EXTERNAL` key and a
   synthetic tenant. Drill packages are marked `"purpose": "drill"`.
2. Run the full release procedure under dual control, including client
   notifications (marked as a drill) and the cooling-off notice.
3. Prove the recovered key works: import into a new staging key, then decrypt
   data written under the original key after rotation.
4. Record the drill in `docs/restore-drills/` (date, officers, client contacts
   notified, package id, check value matched, elapsed time, findings).

## Human steps outside the code

- Deploy the vault template in the escrow account and complete provisioning.
- Escrow agreement, fees and consent wording (#42); governance oversight (#43).
- First staging release rehearsal under dual control, with the drill record.
- Access Analyzer evidence attached to the provisioning and release records.
