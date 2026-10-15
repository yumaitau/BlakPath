# Offboarding and erasure

BlakPath records human decisions. It does not score, rank, predict, infer,
auto-approve or auto-reject Aboriginality. Offboarding returns or removes
custody of records. It never creates an automated identity judgement.

This page states how long deleted data can remain in backups. Privacy notices
and council offboarding procedures need that period. It is not legal advice.
A council and its advisers choose the words they publish to applicants.

## What deletion means in the live system

- Organisation retention defaults live on
  `organisation_settings.retentionDefaults`. A soft delete (`deletedAt`) is
  reversible until a retention job hard-deletes the row.
- Retention jobs are tenant-scoped and audited
  (`docs/privacy-architecture.md`).
- A recorded determination or issued certificate is an official record. Backup
  expiry is not how an official record is kept or destroyed.
- The audit trail is not deleted row by row (`docs/audit-log-design.md`).
- Redis is not backed up. Queues and rate limits are ephemeral. Offboarding
  does not leave a Redis archive of personal information.

## How long deleted data remains in AWS Backup

Production recovery points are defined by
`infra/aws/backup-plan.example.yaml`. They stay in `ap-southeast-2` only. The
vault denies copies out, so there is no cross-region replica.

Vault `blakpath-production` is encrypted with a BlakPath CMK and locked in
**compliance mode**:

- **Minimum retention is 35 days.** No recovery point can be deleted sooner
  than 35 days after it was created. Compliance mode refuses an early delete,
  so an erasure request cannot be accelerated inside the vault.
- **Maximum retention is 90 days.** No recovery point is kept longer.
- **Continuous point-in-time recovery keeps 35 days** for RDS and for the
  evidence and quarantine buckets.
- **Daily snapshots keep 90 days.** One snapshot is taken at 03:00
  `Australia/Sydney` and deleted 90 days after that snapshot.
- **Cooling-off is 7 days.** After that, nobody, including the account root,
  can remove the lock or relax it.

Deleting a row, object or tenant from the live system does not delete the
copies inside existing recovery points.

Tenant key deletion: sealed database fields in RDS recovery points stay
ciphertext under the tenant CMK. S3 recovery points are re-encrypted under the
vault CMK, so deleting a tenant key does not shred that tenant's objects in
them before expiry. This is an open decision (`infra/aws/README.md`).

Worst case after a live delete: **90 days**. The daily snapshot that still
contains the data expires 90 days after that snapshot was taken. The 35-day
continuous window is shorter, so the daily snapshot sets the maximum. After
expiry, AWS Backup removes the recovery point. The vault is not a longer
archive.

The quarantine bucket is included. Uploads can contain personal information
before malware scanning finishes. A restored quarantine object is still
unscanned and must not be promoted or downloaded around the scanner.

## What operators do on erasure or offboarding

1. Remove or export custody in the live database and both buckets through the
   audited retention path. Record what was removed and when.
2. Say, in the privacy notice, that backup copies can remain for up to 90 days
   and cannot be deleted sooner than the vault lock allows.
3. Do not restore a recovery point over the live environment to recover a
   single object after an erasure. A restore brings back later deletions too.
4. When an incident restore is required, restore into an isolated target.
   Before anyone is given access, re-apply every audited deletion that
   happened after the recovery point.
5. A litigation hold stops the retention job from purging the live record. The
   hold does not extend backup retention past 90 days. Keep anything that must
   outlive 90 days in the live system under the hold.

## What this does not change

Application retention can be shorter or longer than 90 days. Shorter live
retention still leaves backup copies until the recovery point expires. Longer
live retention does not keep a backup past 90 days.
