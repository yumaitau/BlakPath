# Council onboarding — new tenant in production

For deployment owners bringing a local council or community organisation onto
BlakPath. Data residency stays `ap-southeast-2` throughout.

## 1. Create tenant

1. Reserve the organisation slug and legal name. Do not insert the organisation
   row by hand.
2. Seed system roles + permission catalogue (`pnpm db:seed` covers platform
   defaults; tenant clones roles on first admin sign-in).
3. Email the first administrator with the operator job
   `infra/k8s/jobs/invite-admin` (`pnpm admin:invite`). The job creates
   the organisation (`organisationType='council'`, status `onboarding`,
   applications closed, region `ap-southeast-2`), assigns only the
   organisation-administrator role, and does not create a password. Production
   keeps organisation tools closed until that person enrols a passkey or
   authenticator. Further staff are invited from the people screen. The job
   refuses when any organisation already exists.
4. Create teams (Intake, Casework, Committee support) and groups via
   `/settings/teams` or `POST /api/teams`, `/api/groups`.
5. Record consent wording + evidence requirements in `organisation_settings`.

## 2. Identity

- Invite staff via membership invitations (hash-only tokens, verified email).
- Assign team/group memberships. Verify deny-by-default with
  `tests/e2e/team-isolation.spec.ts` against staging.
- Optional SSO: register provider (`src/lib/auth/sso-provider.ts`), add
  binding `POST /api/sso/providers`, verify domain in `organisation_domains`,
  then enable. SCIM, if used, needs a per-organisation credential from
  `POST /api/scim/credentials` (hashed at rest, rotatable, revocable). The IdP
  calls `/api/scim/v2/{orgId}/Users` with that credential. Group display names
  must match role slugs. `organisation-admin` stays unavailable unless the
  credential is created with `allowOrganisationAdmin: true`.

## 2b. Encryption key

1. Client deploys `infra/client-kms` in their account, or an operator applies
   `infra/aws/tenant-cmk` for a BlakPath-managed key. See
   `docs/client-key-onboarding.md`.
2. An organisation admin steps up and `POST /api/organisation-keys` with the
   key ARN. The handshake must pass, including the wrong-context refusal.
3. Do not mark the organisation active until that validation has passed.

## 3. Go live

1. Complete `docs/production-readiness.md` release gate in exact EKS images.
2. Run EKS restore drill (`docs/eks-runbook.md`), attach record.
3. `POST /api/organisation/activation` (step-up). It refuses unless the key
   is validated. Then open `publicApplicationsOpen` when ready.
4. Confirm audit chain clean, alarms firing to on-call, SES suppression flow
   wired (`POST /api/email/events` checks the pinned SNS topic) and the email
   checks in `docs/eks-runbook.md` passed (`dkim=pass spf=pass dmarc=pass`).

## 4. Legacy import

Bulk imports run as privileged worker jobs with tenant binding, quarantined
evidence rescanned, every created record audited. No silent auto-determination:
imported matters enter at intake states only.
