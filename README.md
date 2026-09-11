# BlakPath

> **Public code. Open for audit.** This repository is public under
> [`yumaitau`](https://github.com/yumaitau) so any community member, council,
> auditor or researcher can read, review and verify exactly what the software
> does. No hidden logic. No hidden determination. See
> [`docs/threat-model.md`](docs/threat-model.md),
> [`docs/privacy-architecture.md`](docs/privacy-architecture.md) and
> [`docs/audit-log-design.md`](docs/audit-log-design.md) to verify.

BlakPath is a trusted, community-controlled platform for **Confirmation of
Aboriginality (CoA)**. It serves **authorised Aboriginal and Torres Strait
Islander organisations** today, and is built to be reused by **any local
council or community organisation** that needs a trauma-aware, accessible,
auditable CoA workspace.

It gives authorised staff a trauma-aware, accessible, auditable workspace to
receive applications, hold sensitive supporting evidence, manage genealogy and
correspondence, and record the decisions their organisation makes — all under
strict tenant isolation and Australian data residency.

## Interface preview

All README images are in the gallery below, which is collapsed by default so
the README stays easy to scan. The gallery is exhaustive: it contains every
image currently stored in `docs/screenshots`, including the analytics dashboard
with its workload indicators and activity charts.

<details>
<summary>Open all 8 screenshots, including the analytics dashboard</summary>

### Screenshot index

1. Public landing page
2. Staff sign-in page
3. Organisation picker
4. Staff dashboard
5. Work board
6. Forms
7. Committee meetings
8. Account security

### Public entry

![BlakPath landing page](docs/screenshots/landing-page.png)

### Staff workflow

![BlakPath sign in page](docs/screenshots/sign-in.png)

![BlakPath organisation picker](docs/screenshots/organisation-picker.png)

![BlakPath dashboard](docs/screenshots/dashboard.png)

![BlakPath work board](docs/screenshots/work-board.png)

![BlakPath forms](docs/screenshots/forms.png)

![BlakPath committee meetings](docs/screenshots/meetings.png)

![BlakPath account security](docs/screenshots/account-security.png)

</details>

## A straightforward staff workspace

The staff workspace is designed for people who should not need to understand
the platform's underlying systems to use it.

- The top navigation takes staff directly to the dashboard, work board,
  meetings, forms and account settings.
- The dashboard starts with clear counts and visual workload charts, then
  highlights items that need attention.
- The work board has an **Add task** action and accepts drops into every column,
  including an empty one.
- Empty pages explain what the page is for and offer the next useful action,
  such as creating the first form.
- Calendar files use plain-language actions: **Add calendar file** and
  **Download calendar file**.

## The one rule everything else serves

> **BlakPath never determines Aboriginality.**
>
> The software does not score, rank, predict, infer, auto-approve or
> auto-reject. There is no algorithm that judges a person's identity. That
> authority rests **entirely with authorised humans inside the relevant
> Aboriginal or Torres Strait Islander organisation.** BlakPath's job is to be a
> respectful, secure, well-audited tool that supports those people — never to
> replace their judgement.

Everything in this codebase — the schema, the tenancy layer, the audit trail,
the AI boundaries — exists to keep that promise. If a proposed feature could be
read as the software making an identity determination, it does not ship.

## Core principles

- **No automated determination.** See above. AI features are **off by default**
  and may never decide, score, rank or infer identity (`AI_FEATURES_ENABLED`
  defaults to `false`; see `docs/privacy-architecture.md`).
- **Strict tenant isolation.** Every tenant-owned row carries an
  `organisation_id`. The tenant id is **never** trusted from the browser — it is
  derived and DB-verified in the tenancy layer (`docs/tenant-isolation.md`).
- **Permission-checked, audit-logged.** Every sensitive action is authorised
  against a permission key and written to an append-only, hash-chained audit
  trail (`docs/authorization-matrix.md`, `docs/audit-log-design.md`).
- **Trauma-aware, respectful, accessible.** Plain respectful Australian English;
  WCAG 2.2 AA.
- **Australian data sovereignty.** Data is hosted in `ap-southeast-2`
  (`docs/privacy-architecture.md`).
- **Fail secure.** Uploaded evidence is quarantined and malware-scanned before
  it can be served; if the scanner is unavailable, the file stays quarantined
  (`docs/evidence-scanning-design.md`, `docs/threat-model.md`).

## Tech stack

- **Next.js 16** (App Router, React Server Components) + **TypeScript** (strict)
- **Drizzle ORM** (`drizzle-orm/postgres-js`, snake_case) over **PostgreSQL**
- **Better Auth** (email/password, passkeys, TOTP, recovery codes)
- **BullMQ + ioredis** for background work; **Redis** for ephemeral state
- **@aws-sdk/client-s3** for object storage (MinIO locally, S3 `ap-southeast-2`
  in production); **ClamAV** for malware scanning
- **Zod** for validation, **pino** for logging, **uuidv7** for identifiers
- **Tailwind v4** (`@tailwindcss/postcss`)
- **pnpm** package manager

## Quickstart

Prerequisites: Node `>= 20.11`, `pnpm 9`, Docker + Docker Compose. Full detail
in [`docs/local-development.md`](docs/local-development.md).

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local environment file
cp .env.example .env
#    Generate secrets:
#      openssl rand -base64 48   # BETTER_AUTH_SECRET
#      openssl rand -base64 32   # ENCRYPTION_MASTER_KEY

# 3. Start local infrastructure (Postgres, Redis, MinIO, ClamAV, Mailpit)
docker compose up -d

# 4. Apply database migrations
pnpm db:migrate

# 5. Seed baseline data (permission catalogue, system roles, dev org/user)
pnpm db:seed

# 6. Run the app (and, in another shell, the background worker)
pnpm dev
pnpm worker:dev
```

The app runs at <http://localhost:3000>.

## Common commands

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `pnpm dev`           | Run the Next.js app in development            |
| `pnpm worker:dev`    | Run the BullMQ background worker (watch mode) |
| `pnpm typecheck`     | `tsc --noEmit` (strict)                       |
| `pnpm lint`          | ESLint                                        |
| `pnpm test`          | Unit + integration tests (Vitest)             |
| `pnpm test:e2e`      | End-to-end tests (Playwright)                 |
| `pnpm test:live`     | Full live-service Playwright verification     |
| `pnpm test:restore`  | Backup, restore and recovery verification     |
| `pnpm release:check` | Validate production configuration and roles   |
| `pnpm screenshot`    | Refresh the README screenshot gallery         |
| `pnpm db:generate`   | Generate a migration from schema changes      |
| `pnpm db:migrate`    | Apply migrations                              |
| `pnpm db:studio`     | Open Drizzle Studio                           |
| `pnpm db:seed`       | Seed baseline data                            |

Accessibility acceptance coverage and the required assisted-review record are
documented in [`docs/accessibility-acceptance.md`](docs/accessibility-acceptance.md).

## Repository layout

```text
BlakPath/
├── README.md                     This file
├── docs/                         Architecture & security documentation (below)
├── src/
│   ├── db/
│   │   ├── client.ts             Drizzle instance (raw, non-tenant-scoped)
│   │   ├── tenant-db.ts          Tenant-scoped data access (scopeFor / currentScope)
│   │   ├── migrate.ts            Migration entrypoint
│   │   ├── migrations/           Generated SQL migrations
│   │   ├── seeds/                Baseline data seeds
│   │   └── schema/
│   │       ├── _helpers.ts       primaryId / refId / organisationId / timestamps ...
│   │       ├── enums.ts          Postgres enums (lifecycle & outcome states)
│   │       ├── auth.ts           Better Auth tables (user/session/account/...)
│   │       ├── tenancy.ts        organisations + settings/domains/feature flags
│   │       ├── membership.ts     memberships, roles, permissions (RBAC)
│   │       ├── audit.ts          Append-only audit + integrity checkpoints
│   │       └── index.ts          Schema barrel (must stay exhaustive)
│   └── lib/
│       ├── env.ts                Validated environment config (import { env })
│       └── tenancy/context.ts    AsyncLocalStorage TenantContext
├── worker/                       Background worker entrypoint & jobs
└── tests/                        unit / integration / e2e
```

## Documentation

| Document                                                               | Contents                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                         | Modular monolith, domains, system-context & container diagrams, request lifecycle, worker role |
| [`docs/tenant-isolation.md`](docs/tenant-isolation.md)                 | The isolation model end-to-end and the isolation tests that must pass                          |
| [`docs/authentication.md`](docs/authentication.md)                     | Better Auth, MFA/passkeys/TOTP, sessions, step-up, SSO/SCIM future                             |
| [`docs/authorization-matrix.md`](docs/authorization-matrix.md)         | Roles × permission keys, separation of duties, contextual policies                             |
| [`docs/audit-log-design.md`](docs/audit-log-design.md)                 | Event schema, SHA-256 hash chaining, checkpoints, redaction                                    |
| [`docs/threat-model.md`](docs/threat-model.md)                         | Assets, trust boundaries, STRIDE analysis, mitigations, fail-secure                            |
| [`docs/privacy-architecture.md`](docs/privacy-architecture.md)         | Data minimisation, sovereignty, envelope encryption, AI boundaries                             |
| [`docs/production-readiness.md`](docs/production-readiness.md)         | Production release gate, monitoring, backups and restore drills                                |
| [`docs/operations-runbook.md`](docs/operations-runbook.md)             | Alert signals and incident response actions                                                    |
| [`docs/evidence-scanning-design.md`](docs/evidence-scanning-design.md) | Secure upload → quarantine → ClamAV → promote/serve lifecycle                                  |
| [`docs/local-development.md`](docs/local-development.md)               | Setup, services, commands, testing, troubleshooting                                            |
| [`docs/council-trust-model.md`](docs/council-trust-model.md)           | Councils as tenants, clients, teams/groups, Better Auth boundary, onboarding                   |
| [`docs/calendar-vision.md`](docs/calendar-vision.md)                   | RangerOS-parity calendar: views, recurrence, attendees, reminders, build order                  |
| [`docs/e2e-journeys.md`](docs/e2e-journeys.md)                         | Full user-journey e2e matrix across auth, CoA, teams, calendar                                  |
| [`docs/eks-runbook.md`](docs/eks-runbook.md)                           | EKS deploy, data services, SES, restore drill, alarms                                           |
| [`docs/council-onboarding.md`](docs/council-onboarding.md)             | New council tenant: teams, identity/SSO, go-live gate, legacy import                            |

## Licence & governance — open code, community authority

BlakPath code is public and auditable. Data governance and cultural authority
stay with the relevant Aboriginal and Torres Strait Islander organisations,
councils and communities. The software is a custodial tool, not a
decision-maker.

- **Use by any local council:** any council or authorised community
  organisation can deploy its own isolated tenant, configure its own roles,
  teams and groups, and administer CoA without sharing data with other
  tenants. Tenant isolation is enforced per `organisation_id`
  (`docs/tenant-isolation.md`).
- **Audit it:** all sensitive actions are permission-checked and written to an
  append-only, hash-chained audit trail (`docs/audit-log-design.md`).
  Report issues via GitHub Issues; security issues via the process in
  `docs/operations-runbook.md`.
