# Non-production restore drill — 13 July 2026

- Operator: Justin Middler
- Started: 2026-07-13 13:59:50 UTC
- Finished: 2026-07-13 14:01:25 UTC
- Measured recovery time: **95 seconds**
- Source and target: separate disposable local Compose projects with isolated
  PostgreSQL and MinIO volumes; no production or personal data was used.

This record is the local logical drill. A production drill uses a recovery
point from the compliance-locked vault in `infra/aws/backup-plan.example.yaml`,
checked with `list-protected-resources` (`docs/operations-runbook.md`).

## Result

- PostgreSQL logical backup and restore: passed.
- Evidence and empty quarantine bucket backup/restore: passed.
- Restored evidence SHA-256 matched its database record: passed.
- All 43 tenant audit events verified as one clean hash chain before backup and
  after restore: passed.
- Restored administrator sign-in and organisation selection: passed.
- Authorised evidence download through the application: passed; the response
  remained forced to attachment.
- Public-form response and application record presence: passed.
- Cleanup of drill containers, networks, volumes and temporary backup: passed.

## Findings and follow-up

The first exercises found two defects, both corrected before this successful
record:

1. An empty quarantine bucket did not create a mirror directory. The backup now
   represents empty buckets explicitly and restores them successfully.
2. Concurrent web and worker audit writes could share a millisecond timestamp,
   allowing UUID tie-break order to differ from hash-link order. Audit appends now
   assign a strictly increasing per-chain database timestamp while holding the
   advisory lock, with a concurrent 24-append integration regression test.

Production rollout still requires the deployment owner to execute the same drill
against managed `ap-southeast-2` recovery points and record the environment’s
agreed RTO/RPO outcome.
