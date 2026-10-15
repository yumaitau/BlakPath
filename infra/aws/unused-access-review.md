# Unused-access review — BlakPath workload roles

Static review of `workload-roles.example.yaml` against the code those pods
run. IAM Access Analyzer unused-access findings, after the roles have been
live for the tracking window, are checked against this list. A finding is a
prompt to delete an action, not a prompt to add one.

BlakPath never determines Aboriginality. These roles move and seal records.
They do not score, rank, or decide identity.

## How the split works

| Identity           | AWS role                           | Why                                                                       |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `blakpath-web`     | `blakpath-web` via Pod Identity    | HTTP app: presigns, certificate PDFs, CoA signing, auth email, readiness. |
| `blakpath-worker`  | `blakpath-worker` via Pod Identity | Scans, promotes, exports, retention deletes, queued email.                |
| `blakpath-clamav`  | none                               | Malware daemon. `automountServiceAccountToken: false`. No association.    |
| `blakpath-migrate` | none                               | Migrate and seed jobs. Token off. No association.                         |

Trust on both roles is `pods.eks.amazonaws.com` with `sts:AssumeRole` and
`sts:TagSession`, limited to namespace `blakpath`, that service account, and
the cluster name parameter. Leave session tags enabled on the association.
Disabling them makes assumption fail.

Runtime secrets are not on these roles. External Secrets Operator uses the
shared platform role and syncs `blakpath-runtime`. Workload pods receive the
Kubernetes Secret, not `secretsmanager:GetSecretValue`.

Object keys the policies follow:

- evidence uploads: `{org}/applications/{application}/evidence/{id}`
- certificate PDFs: `{org}/certificates/{id}.pdf`
- export CSVs: `{org}/exports/{id}.csv`

## blakpath-web — kept

| Action                                              | Resource                                                                                                    | Caller                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `s3:ListBucket`                                     | evidence bucket                                                                                             | `checkS3` (`HeadBucket`) from `/api/ready`                                                      |
| `s3:PutObject`                                      | quarantine `*/applications/*/evidence/*`                                                                    | `presignUpload`                                                                                 |
| `s3:PutObject`                                      | evidence `*/certificates/*`                                                                                 | `putObjectBytes` in `src/domains/certificates/service.ts`                                       |
| `s3:GetObject`                                      | evidence application, certificate, and export prefixes                                                      | `presignDownload` for evidence, certificates, and exports                                       |
| `kms:Decrypt`, `kms:GenerateDataKey`                | evidence CMK, `kms:ViaService` = S3                                                                         | SSE-KMS on those puts and gets                                                                  |
| `kms:Sign`, `kms:GetPublicKey`                      | CoA signing CMK only                                                                                        | `signCoaPayload` / `getCoaPublicKeyPem` in `src/lib/kms/sign.ts`                                |
| `kms:Decrypt`, `kms:GenerateDataKey`                | platform CMK                                                                                                | platform-scope envelopes in `src/lib/encryption/scope.ts`                                       |
| `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey` | any key, encryption-context `purpose` in `field`, `platform`, `blind-index`, `key_validation`, `key_health` | tenant envelopes, blind index, key handshake and the Settings key check (`src/lib/encryption/`) |
| `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey` | any key via S3, object ARN in evidence or quarantine                                                        | SSE-KMS under the tenant CMK on presigned puts and gets                                         |
| `ses:SendEmail`                                     | the application From address                                                                                | synchronous auth mail in `src/lib/email/mailer.ts`. Attached by `eks-boundary.example.yaml`     |

## blakpath-web — denied or not granted

| Action                                                             | Decision                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3:DeleteObject`, `s3:DeleteObjectVersion` on evidence objects    | **Explicit deny.** Scan rejection and retention run on the worker. The web role cannot delete evidence.                                                                                               |
| `s3:GetObject` on quarantine                                       | Not granted. The web tier presigns the upload and never reads unscanned bytes.                                                                                                                        |
| `s3:PutObject` on evidence outside `certificates/`                 | Not granted. Promotion and exports are worker writes.                                                                                                                                                 |
| `kms:Encrypt` on the evidence CMK, `kms:DescribeKey`, `kms:Verify` | Not granted. S3 calls `GenerateDataKey`. Verification uses the public key locally after `GetPublicKey`. `sign.ts` does not call `DescribeKey`. Tenant `kms:Encrypt` is limited by encryption context. |
| `kms:Sign` on the evidence CMK                                     | Not granted. Sign is only on the CoA signing key.                                                                                                                                                     |
| `secretsmanager:*`                                                 | Not granted.                                                                                                                                                                                          |

## blakpath-worker — kept

| Action                                                      | Resource                                                                   | Caller                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | quarantine evidence prefix                                                 | scan reads bytes; rejection, infection, and post-copy delete; retention removes every version                    |
| `s3:PutObject`                                              | evidence application prefix and `*/exports/*`                              | `CopyObject` promote; `processExport` CSV                                                                        |
| `s3:DeleteObject`, `s3:DeleteObjectVersion`                 | evidence application prefix only                                           | retention sweep (`deleteAllObjectVersions`). Removes every version and delete marker of a purged key.            |
| `s3:ListBucketVersions`                                     | evidence and quarantine buckets                                            | retention sweep lists the versions of one key before deleting them                                               |
| `s3:GetObject`                                              | evidence application prefix                                                | tenant key rewrap copies each evidence object onto itself (`src/lib/storage/object-rewrap.ts`)                   |
| `kms:Decrypt`, `kms:GenerateDataKey`                        | evidence CMK via S3                                                        | SSE-KMS on the scan read, the promote, and the export write                                                      |
| `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`             | audit anchor bucket only                                                   | daily chain-head anchors (`src/domains/audit/anchor-s3.ts`). Delete and governance bypass are explicitly denied. |
| `kms:Sign`, `kms:GetPublicKey`, `kms:DescribeKey`           | audit anchor signing CMK only                                              | `loadAnchorSigner` in `src/domains/audit/anchor-sign.ts`                                                         |
| `kms:Decrypt`, `kms:GenerateDataKey`                        | platform CMK                                                               | platform-scope envelopes                                                                                         |
| `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey`         | any key, `purpose` in `field`, `platform`, `blind-index`, `key_validation` | tenant envelopes and key rewrap                                                                                  |
| `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey`         | any key via S3, object ARN in evidence or quarantine                       | SSE-KMS under the tenant CMK on scan, promote and rewrap                                                         |
| `kms:DescribeKey`                                           | any key                                                                    | tenant key checks in `src/lib/encryption/kms-provider.ts`. No encryption context exists for `DescribeKey`.       |
| `ses:SendEmail`                                             | the application From address                                               | worker email and notification processors. Attached by `eks-boundary.example.yaml`                                |

## blakpath-worker — denied or not granted

| Action                                             | Decision                                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms:Sign`                                         | **Explicit deny on every key except the audit anchor key** (`NotResource`). Certificate signing is a human action served by the web process. The worker cannot sign a certificate even if another statement is added later. |
| `kms:GetPublicKey` on the CoA key                  | Not granted. Public verification is the web `/verify` route.                                                                                                                                                                |
| `s3:GetObject` on certificates or exports          | Not granted. Download URLs are presigned by the web role.                                                                                                                                                                   |
| `s3:DeleteObject` on `certificates/` or `exports/` | Not granted.                                                                                                                                                                                                                |
| `s3:ListBucket` on evidence or quarantine          | Not granted. The worker does not call `HeadBucket`. (`s3:ListBucketVersions` is granted for retention.)                                                                                                                     |
| `s3:PutObject` on quarantine                       | Not granted. Uploads are presigned by web.                                                                                                                                                                                  |
| `secretsmanager:*`                                 | Not granted.                                                                                                                                                                                                                |

## ClamAV and migrate

No `AWS::EKS::PodIdentityAssociation` for `blakpath-clamav` or
`blakpath-migrate`. ClamAV's service account sets
`automountServiceAccountToken: false`, and the pod sets it again. Without a
token and without an association, the scanner cannot obtain AWS credentials.

## Access Analyzer procedure

Apply `unused-access-analyzer.example.yaml` in `ap-southeast-2` only when the
account does not already have an `ACCOUNT_UNUSED_ACCESS` analyzer. Tracking
period is 90 days. One analyzer covers the account; review is per role.

After web and worker have served production traffic for that window:

1. List active unused-access findings whose resource is `blakpath-web` or `blakpath-worker`.
2. An unused action that is in the "kept" tables above and still has a caller in code stays. Confirm the caller still runs in that pod before deleting it.
3. An unused action with no remaining caller is removed from `workload-roles.example.yaml` in a follow-up change.
4. `blakpath-clamav` and `blakpath-migrate` must not appear. They are not roles.
5. Do not add an action because a service "might" need it. New actions need a code caller and an update to this review.

`ses:SendEmail` on both roles is expected while auth mail and queued mail use
the SES API (`SMTP_USER` unset). When PaperBoy replaces that path, this
review should drop `ses:SendEmail` if the analyzer shows it unused.

## Key policies (not in this template)

Identity policies are not enough. The evidence CMK key policy must allow both
roles `kms:Decrypt` and `kms:GenerateDataKey` via S3. The CoA signing key
policy must allow only `blakpath-web` `kms:Sign` and `kms:GetPublicKey`.
Customer-held keys (epic #117) attach those grants per tenant. That key-policy
work is not done here.
