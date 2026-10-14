#!/usr/bin/env bash
# Fail when src/db/schema does not match the committed Drizzle migrations.
# `drizzle-kit check` validates the journal and snapshots. `generate` must
# produce no new files; a diff means the schema changed without a migration.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required (a dummy URL is enough; generate does not connect)" >&2
  exit 1
fi

pnpm exec drizzle-kit check
pnpm exec drizzle-kit generate --name __ci_drift_check </dev/null

if [[ -n "$(git status --porcelain -- src/db/migrations)" ]]; then
  echo "Schema drift: drizzle-kit generate produced a migration." >&2
  echo "Commit an intentional migration, or revert the schema change. Do not use db:push." >&2
  git status --porcelain -- src/db/migrations >&2
  git diff -- src/db/migrations >&2
  exit 1
fi

echo "migration journal matches the schema"
