# Disposable Postgres migration drill — 13 October 2026

- Operator: grok/issue-55 rehearsal
- Finished: 2026-10-13 10:18:56 UTC
- Source: Postgres 16 started for this drill only, then removed
- Not a staging or production cluster. No tenant data.

This rehearses the rollback steps in `docs/eks-runbook.md` against an empty
database. It does not replace the required staging rehearsal.

## Result

- `infra/postgres/roles.sql` applied. Database owner is `blakpath_migrator`.
  `blakpath_app` can connect and select. It cannot create in `public`, and it
  cannot read `drizzle`.
- The app-image migrator bundle (`migrate.cjs`, `NODE_ENV=production`,
  `DATABASE_MIGRATOR_URL` only) applied journal entries `0000` through `0018`.
  A second run changed nothing.
- A blocked `ALTER TABLE` aborted in 2315 ms, under the five-second limit.
- `CREATE INDEX CONCURRENTLY` ran outside a transaction. Repeating that
  migration did not rebuild the index.
- Expand: a nullable column was added after an existing insert. An insert that
  uses only the previous columns still succeeded. No down migration was run.
  The old row shape remained readable, which is the release N-1 on schema N
  case.
- Code rollback in the runbook is redeploying the previous image digest and
  not running a migrate Job. This drill had no cluster, so Deployments were
  not changed. `scripts/cd-release.sh` applies Deployments only after the
  migrate Job is complete.

## Still required

Run rollback steps 1 and 2 once against the staging cluster and record that
rehearsal separately. Apply `infra/postgres/roles.sql` as the RDS master and
store `DATABASE_MIGRATOR_URL` only in `/blakpath/production/migrator` before
the first production migrate Job.
