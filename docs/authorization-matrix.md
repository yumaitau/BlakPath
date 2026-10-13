# Authorisation matrix

Access in BlakPath is **always permission-checked**. A user's mere existence
grants nothing. Access flows only from: an **active membership** of an
organisation → **roles** held within that membership → **permission keys**
bundled by those roles — all scoped to a single tenant
(`src/db/schema/membership.ts`).

> BlakPath never determines Aboriginality. No permission grants a power to
> auto-decide, score, rank or infer identity. The most a role can do is let an
> authorised human **record** a decision that human has made.

## How it fits together

- **Permissions** (`permissions` table): the catalogue. `key` is the stable
  identifier checked at every gate (e.g. `application:read-assigned`), with a
  `category` and human `description`.
- **Roles** (`roles` table): bundles of permissions. A role with a null
  `organisation_id` is a reusable **system template**; a tenant-owned role
  carries the tenant's `organisation_id`. `isSystem` marks built-ins that must
  not be deleted.
- **Role → permission** (`role_permissions`): which keys a role grants.
- **Membership → role** (`membership_roles`): which roles a member holds.

A permission check resolves the caller's membership, collects the permission
keys from their roles, and confirms the required key is present — the resolved
set is cached on the verified `TenantContext.permissions`
(`src/lib/tenancy/context.ts`).

## Permission key catalogue

Permission keys are namespaced `resource:action`. The executable catalogue is
`src/lib/permissions/catalog.ts`, and system-role grants are
`src/lib/permissions/roles.ts`. Docs use those names. Audit access is
`audit:view` only. Chain verification is a worker job, not a permission
(`docs/audit-log-design.md`).

The table below is an earlier draft. Where a key is not in the catalogue, the
catalogue wins. The audit row matches the catalogue.

| Category       | Key                                 | Description                                              |
| -------------- | ----------------------------------- | -------------------------------------------------------- |
| organisation   | `organisation:read`                 | View organisation profile and status                     |
| organisation   | `organisation:update`               | Edit organisation profile                                |
| organisation   | `organisation:manage-settings`      | Edit settings, terminology, guidance, retention defaults |
| organisation   | `organisation:manage-domains`       | Add/verify organisation email domains                    |
| organisation   | `organisation:manage-feature-flags` | Toggle tenant feature flags                              |
| membership     | `membership:read`                   | View members of the organisation                         |
| membership     | `membership:invite`                 | Invite a person to the organisation                      |
| membership     | `membership:manage`                 | Change member status (suspend/revoke)                    |
| membership     | `membership:assign-roles`           | Assign/remove roles on a membership                      |
| role           | `role:read`                         | View roles and their permissions                         |
| role           | `role:manage`                       | Create/edit/delete tenant roles and grants               |
| representative | `representative:read`               | View representative authorisations                       |
| representative | `representative:manage`             | Grant/revoke representative access                       |
| application    | `application:read-assigned`         | View applications assigned to the user                   |
| application    | `application:read-all`              | View all applications in the organisation                |
| application    | `application:create`                | Record/start a new application                           |
| application    | `application:update`                | Edit application details/status (non-determinative)      |
| application    | `application:assign`                | Assign an application to a caseworker                    |
| evidence       | `evidence:upload`                   | Upload supporting evidence (to quarantine)               |
| evidence       | `evidence:read`                     | View/download promoted (scanned-clean) evidence          |
| evidence       | `evidence:manage`                   | Replace/withdraw evidence                                |
| genealogy      | `genealogy:read`                    | View genealogy records                                   |
| genealogy      | `genealogy:manage`                  | Create/edit genealogy records                            |
| decision       | `decision:record`                   | Record a human determination outcome                     |
| decision       | `decision:review`                   | Second-person review of a recorded decision              |
| certificate    | `certificate:issue`                 | Issue a certificate for an approved decision             |
| certificate    | `certificate:revoke`                | Revoke a previously issued certificate                   |
| audit          | `audit:view`                        | View the tamper-evident audit trail for the organisation |

## Roles × permissions

`✓` = granted. System templates; tenants may clone and tailor them.

| Permission key                      | Applicant Liaison | Caseworker | Reviewer | Certifying Officer | Org Admin | Auditor |
| ----------------------------------- | :---------------: | :--------: | :------: | :----------------: | :-------: | :-----: |
| `organisation:read`                 |         ✓         |     ✓      |    ✓     |         ✓          |     ✓     |    ✓    |
| `organisation:update`               |                   |            |          |                    |     ✓     |         |
| `organisation:manage-settings`      |                   |            |          |                    |     ✓     |         |
| `organisation:manage-domains`       |                   |            |          |                    |     ✓     |         |
| `organisation:manage-feature-flags` |                   |            |          |                    |     ✓     |         |
| `membership:read`                   |                   |     ✓      |    ✓     |         ✓          |     ✓     |    ✓    |
| `membership:invite`                 |                   |            |          |                    |     ✓     |         |
| `membership:manage`                 |                   |            |          |                    |     ✓     |         |
| `membership:assign-roles`           |                   |            |          |                    |     ✓     |         |
| `role:read`                         |                   |            |          |                    |     ✓     |    ✓    |
| `role:manage`                       |                   |            |          |                    |     ✓     |         |
| `representative:read`               |         ✓         |     ✓      |          |                    |     ✓     |         |
| `representative:manage`             |         ✓         |            |          |                    |     ✓     |         |
| `application:read-assigned`         |         ✓         |     ✓      |    ✓     |         ✓          |     ✓     |         |
| `application:read-all`              |                   |            |    ✓     |         ✓          |     ✓     |         |
| `application:create`                |         ✓         |     ✓      |          |                    |     ✓     |         |
| `application:update`                |         ✓         |     ✓      |          |                    |     ✓     |         |
| `application:assign`                |                   |            |    ✓     |                    |     ✓     |         |
| `evidence:upload`                   |         ✓         |     ✓      |          |                    |     ✓     |         |
| `evidence:read`                     |                   |     ✓      |    ✓     |         ✓          |     ✓     |         |
| `evidence:manage`                   |                   |     ✓      |          |                    |     ✓     |         |
| `genealogy:read`                    |                   |     ✓      |    ✓     |         ✓          |     ✓     |         |
| `genealogy:manage`                  |                   |     ✓      |          |                    |     ✓     |         |
| `decision:record`                   |                   |            |    ✓     |                    |     ✓     |         |
| `decision:review`                   |                   |            |          |         ✓          |     ✓     |         |
| `certificate:issue`                 |                   |            |          |         ✓          |           |         |
| `certificate:revoke`                |                   |            |          |         ✓          |     ✓     |         |
| `audit:view`                        |                   |            |          |                    |     ✓     |         |

Notes:

- **Org Admin** manages people and configuration but is deliberately **not**
  granted `decision:record`, `decision:review` or `certificate:issue` by
  default — administrative power is separated from determination power.
- **Auditor** in this draft table is not a system role. `organisation-admin`
  holds `audit:view` and no case-mutation permissions. A tenant may clone a
  read-only role and grant `audit:view` alone.

## Separation-of-duties rules

Enforced in domain services on top of the permission check:

1. **No self-review.** The user who holds `decision:record` on an application
   cannot be the same user who provides `decision:review` for it. Reviewer and
   Certifying Officer must be distinct people.
2. **Record vs certify are distinct powers.** `decision:record` (Reviewer) and
   `certificate:issue` (Certifying Officer) are held by different roles; issuing
   a certificate requires an existing recorded, reviewed decision.
3. **Admin does not adjudicate.** Managing members/roles/settings
   (`organisation:*`, `membership:*`, `role:*`) does not by itself confer
   `decision:record` or `certificate:issue`.
4. **Granting representative access is not self-serving.** A user cannot grant
   themselves representative access to another person's application.
5. **Audit access does not edit cases.** `audit:view` reads and exports the
   trail and records that a human completed the monthly review. On
   `organisation-admin` it is not bundled with application, evidence, decision
   or certificate permissions.

## Contextual policies

Permission keys answer "may this role do this kind of thing"; contextual policies
answer "for this specific record, right now":

- **Assignment scoping.** `application:read-assigned` only returns applications
  where the caller is the assigned caseworker; `application:read-all` is required
  to see the rest.
- **Tenant scoping.** Every check runs inside a verified `TenantContext`; a
  permission only ever applies within the caller's own organisation
  (`docs/tenant-isolation.md`).
- **Membership status gate.** A membership must be `active`
  (`membership_status`) for any of its permissions to apply; `invited`,
  `suspended` and `revoked` confer nothing.
- **Evidence readiness.** `evidence:read` only serves objects that have passed
  scanning and been promoted; quarantined objects are never served regardless of
  permission (`docs/evidence-scanning-design.md`).
- **Representative time-boxing.** Representative access is honoured only while the
  `representative_authorisations` grant is `active` and unexpired/unrevoked, and
  (when the consent domain lands) tied to a consent record.
- **Step-up for sensitive actions.** Actions such as `decision:record`,
  `certificate:issue`/`certificate:revoke` and break-glass require a recent
  successful authentication (`sessions.lastAuthenticatedAt`); see
  `docs/authentication.md`.
- **Break-glass, not standing access.** Platform operators
  (`users.isPlatformOperator`) hold **no** tenant permissions. Cross-tenant
  access is only ever granted through an approved, time-boxed, tenant-notified
  break-glass request (`break_glass_requests`).

Every check — permitted, **denied**, or errored — is written to the audit trail
with the acting role recorded (`docs/audit-log-design.md`).
