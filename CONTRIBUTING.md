# Contributing to BlakPath

Thank you for reviewing and improving BlakPath. The product rule below is not
optional.

## Product rule

BlakPath never determines Aboriginality. Nothing in this repository may score,
rank, predict, infer, auto-approve or auto-reject identity. All outcomes are
recorded human acts. A change that lets software determine identity will not
be accepted.

## Licence

Source code is licensed under the GNU Affero General Public License, version 3
only (`AGPL-3.0-only`). See [`LICENSE`](LICENSE) and the licence section of
[`README.md`](README.md).

Submit a contribution only if you can license it that same way. This file is
not legal advice; the licence text controls.

The licence does not cover community records, personal information or cultural
knowledge.

## Security

Do not report a vulnerability in an issue or pull request. Use
[`SECURITY.md`](SECURITY.md). Do not include personal information, evidence,
genealogy or secrets in a public contribution.

## Code owners

[`.github/CODEOWNERS`](.github/CODEOWNERS) lists the security-sensitive paths
and their owners. It is the source of truth; this guide does not repeat it.
Pull requests land on `main` only through the ruleset and merge queue
described in [`docs/branch-protection.md`](docs/branch-protection.md), which
also says when code owner review becomes required.

## Development

Follow [`docs/local-development.md`](docs/local-development.md). Before you
open a pull request, run:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check` (`pnpm format` fixes layout)
- `pnpm test`

Schema changes go in `src/db/schema`, then `pnpm db:generate`. Do not
hand-edit migration snapshots, and do not use `pnpm db:push`.

CI installs with `pnpm install --frozen-lockfile`. Commit `pnpm-lock.yaml`
when you change dependencies.

## Pull requests

Use the pull request template. The identity answer must stay **no**. Describe
tenant-isolation and permission effects when a change touches data access.
