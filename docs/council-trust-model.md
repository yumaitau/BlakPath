# Council trust model — clients, councils, teams, groups

Council = `organisations` tenant. Client = applicant person / matter owner.
Better Auth authenticates who. Tenancy + RBAC authorises what, per tenant.

## Mapping

- `organisations.organisationType`: `council` | `community-org` | `authority`.
  Any local council gets isolated tenant. No cross-tenant reads.
- `clients`: tenant-scoped person record. Links optional `users` account.
  One client owns many `applications` (follow-up FK `applications.clientId`).
- `teams`: tenant-scoped work units (intake, casework, committee support).
- `team_memberships`: user in team, role `lead` | `member`.
- `groups`: sub-units inside team, or cross-team permission bundles.
- `group_memberships`: user in group.
- Access rule: active membership + team/group assignment + permission key.
  No assignment = no data, even with valid session.

## Better Auth boundary

Keep current Better Auth config (`src/lib/auth/index.ts`): email/password,
passkey, TOTP. No Better Auth Organization plugin. Reason: custom tenancy
gives DB-verified isolation, org-leading indexes, hash-chained audit. Auth
stays identity only. `activeOrganisationId` session field remains
server-written, `input:false`, re-verified per request.

## Permission keys added

`team:create`, `team:manage`, `group:create`, `group:manage`,
`client:create`, `client:read-assigned`, `client:read-any`,
`client:assign-team`, `calendar:create`, `calendar:read-any`,
`calendar:update-any`, `calendar:delete-any`. See
`src/lib/permissions/catalog.ts`. No key ever authorises machine
determination of Aboriginality.

## Council onboarding

1. Create organisation `organisationType='council'`, status onboarding.
2. Seed system roles, create council teams (Intake, Casework, Committee).
3. Invite staff via `membership_invitations` (hash only, email-verified).
4. Assign teams/groups, verify isolation with `tests/e2e/team-isolation.spec.ts`.
5. Open public applications when ready.
