# Council onboarding — new tenant in production

For deployment owners bringing a local council or community organisation onto
BlakPath. Data residency stays `ap-southeast-2` throughout.

## 1. Create tenant

1. Insert `organisations` row: `organisationType='council'`, status `onboarding`,
   region `ap-southeast-2`, slug reserved.
2. Seed system roles + permission catalogue (`pnpm db:seed` covers platform
   defaults; tenant clones roles on first admin sign-in).
3. Create teams (Intake, Casework, Committee support) and groups via
   `/settings/teams` or `POST /api/teams`, `/api/groups`.
4. Record consent wording + evidence requirements in `organisation_settings`.

## 2. Identity

- Invite staff via membership invitations (hash-only tokens, verified email).
- Assign team/group memberships. Verify deny-by-default with
  `tests/e2e/team-isolation.spec.ts` against staging.
- Optional SSO (Entra ID): register the BlakPath app in the council tenant
  with redirect URI `https://<app>/api/auth/sso/callback`; put
  `SSO_ENTRA_CLIENT_ID`, `SSO_ENTRA_CLIENT_SECRET` and `SSO_STATE_SECRET` in
  the Secrets Manager runtime secret; add binding `POST /api/sso/providers`
  with the tenant-specific issuer
  `https://login.microsoftonline.com/<tenant-id>/v2.0`; verify the domain in
  `organisation_domains`, then enable. In the Entra app registration, add
  `amr` as an optional ID token claim, and require MFA with Conditional
  Access. BlakPath rejects the sign-in unless `amr` includes a second factor.
  First sign-in links the invited user by UPN on that verified domain, not by
  the mail attribute. Staff must already be invited members. SCIM maps onto
  membership status transitions.

## 3. Go live

1. Complete `docs/production-readiness.md` release gate in exact EKS images.
2. Run EKS restore drill (`docs/eks-runbook.md`), attach record.
3. Flip status to `active`, open `publicApplicationsOpen` when ready.
4. Confirm audit chain clean, alarms firing to on-call, SES suppression flow
   wired (`POST /api/email/events` reachable from SNS).

## 4. Legacy import

Bulk imports run as privileged worker jobs with tenant binding, quarantined
evidence rescanned, every created record audited. No silent auto-determination:
imported matters enter at intake states only.
