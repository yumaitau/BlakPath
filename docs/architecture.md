# Architecture

BlakPath is a **modular monolith** built on Next.js 16 (App Router + React
Server Components) with a single companion **background worker** process. One
deployable web application holds the whole domain, split into clearly bounded
modules that talk to each other through typed service functions rather than over
the network. This keeps operations simple for the size of the problem while
still enforcing strong internal boundaries — every module goes through the same
tenancy, authorisation and audit gates.

> Reminder that shapes every module below: **BlakPath never determines
> Aboriginality.** No module scores, ranks, infers or auto-decides. Modules
> capture information and record the decisions authorised humans make.

## Why a modular monolith

- The workload is I/O-bound case management, not a fan-out of independent
  high-scale services. A monolith removes distributed-systems failure modes
  (partial writes across services, cross-service auth drift) that would be a
  liability for a system holding this kind of sensitive data.
- Strong **in-process boundaries** (a permission check and tenant scope on every
  path) are easier to guarantee and test than cross-network trust.
- The one thing that genuinely benefits from being out-of-band — slow, retried,
  side-effecting work (virus scanning, email, integrity verification) — is
  split into the worker.

## Domains (modules)

Phase 1 lands the platform spine. Later phases add case-management domains on top
of the same tenancy/authorisation/audit foundation.

| Domain                | Responsibility                                                                                                       | Status      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Tenancy**           | Organisations, settings, domains, feature flags; the tenant boundary itself (`src/db/schema/tenancy.ts`)             | Phase 1     |
| **Identity & Auth**   | Better Auth tables and flows: accounts, sessions, passkeys, TOTP (`src/db/schema/auth.ts`)                           | Phase 1     |
| **Membership & RBAC** | Memberships, roles, permission catalogue, role grants, representative authorisations (`src/db/schema/membership.ts`) | Phase 1     |
| **Audit & Integrity** | Append-only hash-chained audit trail, integrity checkpoints, break-glass requests (`src/db/schema/audit.ts`)         | Phase 1     |
| **Applications**      | CoA application intake, status lifecycle, correspondence                                                             | Later phase |
| **Evidence**          | Secure document upload, quarantine → scan → serve lifecycle (`docs/evidence-scanning-design.md`)                     | Phase 3     |
| **Genealogy**         | Family/ancestry records supporting an application                                                                    | Later phase |
| **Decisions**         | Human-recorded determinations and certificate issuance                                                               | Later phase |
| **Consent**           | Consent ledger; ties representative access to recorded consent                                                       | Later phase |
| **Notifications**     | Email and in-app messaging (via the worker)                                                                          | Later phase |

Every future tenant-owned table uses the shared helpers (`organisationId()`,
`primaryId()`, `timestamps`) and is reached through the tenant-scoped data access
layer — new domains inherit isolation, not reinvent it.

## System context

```mermaid
flowchart TB
  applicant["Applicant / representative<br/>(public web)"]
  staff["Authorised organisation staff<br/>(caseworkers, reviewers, admins)"]
  operator["BlakPath platform operator<br/>(support; no standing tenant access)"]

  subgraph blakpath["BlakPath platform (ap-southeast-2)"]
    web["Next.js web app<br/>(RSC + route handlers + server actions)"]
    worker["Background worker<br/>(BullMQ)"]
  end

  pg[("PostgreSQL<br/>tenant + platform data")]
  redis[("Redis<br/>queues / ephemeral state")]
  s3[("Object storage (S3)<br/>evidence + quarantine buckets")]
  clamav["ClamAV<br/>malware scanning"]
  smtp["Email<br/>(SES API; Mailpit locally)"]

  applicant --> web
  staff --> web
  operator -. audited break-glass only .-> web

  web --> pg
  web --> redis
  web --> s3
  worker --> pg
  worker --> redis
  worker --> s3
  worker --> clamav
  web --> smtp
  worker --> smtp
```

Platform operators do **not** get standing access to tenant data. Any
cross-tenant support access is obtained only through the audited, time-boxed
break-glass flow (`break_glass_requests` in `src/db/schema/audit.ts`).

## Containers

```mermaid
flowchart LR
  subgraph app["Next.js app process"]
    routes["Route handlers /<br/>Server Actions /<br/>RSC"]
    tctx["Tenant context boundary<br/>(runWithTenantContext)"]
    authz["Authorisation<br/>(permission checks)"]
    domain["Domain services<br/>(business logic)"]
    tdb["Tenant-scoped DB access<br/>(scopeFor / currentScope)"]
    audit["Audit writer<br/>(hash-chained)"]
  end

  subgraph wproc["Worker process"]
    queues["Queue consumers<br/>(BullMQ)"]
    jobs["Jobs: scan, email,<br/>integrity verify, retention"]
  end

  db[("Drizzle / postgres-js")]

  routes --> tctx --> authz --> domain
  domain --> tdb --> db
  domain --> audit --> db
  domain -->|enqueue| queues
  queues --> jobs
  jobs --> tdb
  jobs --> audit
```

Key rule: **domain logic never lives in React components or route handlers.**
Route handlers, server actions and RSC establish the tenant context and call
domain services; the services own the business rules, tenant-scoped queries and
audit writes.

## Request lifecycle

A typical authenticated, tenant-scoped mutation:

```mermaid
sequenceDiagram
  participant U as User (browser)
  participant R as Route handler / Server Action
  participant A as Better Auth
  participant M as Membership resolver
  participant C as TenantContext (AsyncLocalStorage)
  participant P as Permission check
  participant S as Domain service
  participant D as Tenant-scoped DB
  participant L as Audit writer

  U->>R: Request (with session cookie + intended action)
  R->>A: Resolve session
  A-->>R: userId, sessionId
  R->>M: Verify membership of target organisation (DB)
  M-->>R: membershipId, roles, permissions (DB-verified)
  R->>C: runWithTenantContext({ orgId, userId, permissions, ... })
  C->>P: requirePermission('application:update')
  alt permission missing
    P-->>L: audit(result = denied)
    P-->>U: 403 (no data leaked)
  else permitted
    P->>S: call domain service
    S->>D: query/write via currentScope() (organisation_id enforced)
    D-->>S: rows (assertOwned re-checks tenant)
    S->>L: audit(result = success, before/after meta)
    S-->>U: response
  end
```

Notes:

- The **organisation id is never taken from request input.** It is derived from
  the resolved session and **verified against the membership row in the
  database** before the context is created. See
  `src/lib/tenancy/context.ts` and `docs/tenant-isolation.md`.
- The context is carried by `AsyncLocalStorage`
  (`runWithTenantContext` / `requireTenantContext`), so `currentScope()` in the
  data layer always has the verified tenant available without threading it
  through every function signature.
- Both **denied** and **failed** attempts are audited, not just successes.

## Background worker

The worker (`worker/index.ts`, run via `pnpm worker`) consumes BullMQ queues on
Redis. It exists for work that must be reliable, retried and off the request
path:

- **Evidence scanning** — pick up a quarantined upload, scan with ClamAV,
  promote clean files or hold/reject infected ones (`docs/evidence-scanning-design.md`).
- **Notifications** — send email via the SES API under the workload role
  (Mailpit SMTP locally; see `docs/adr/0090-production-email-sender.md`).
- **Audit integrity verification** — periodically re-walk the hash chain and
  write/verify integrity checkpoints (`docs/audit-log-design.md`).
- **Retention & lifecycle** — apply retention/deletion policies where lawful,
  respecting official-record obligations (`docs/privacy-architecture.md`).

Jobs run under the **same guarantees as web requests**: a job that touches
tenant data establishes a tenant context, uses the tenant-scoped data layer, and
writes audit events. Queue payloads are validated with Zod and carry the
organisation id, which is re-verified — a queue message is treated as untrusted
input, exactly like a browser request (`docs/tenant-isolation.md`).
