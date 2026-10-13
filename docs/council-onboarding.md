# Council onboarding — new tenant in production

For deployment owners bringing a local council or community organisation onto
BlakPath. Data residency stays `ap-southeast-2` throughout.

## 1. Create tenant

`pnpm db:seed` loads the permission catalogue and system role templates only.
It does not create a production organisation. Provision with the operator
command (or the Kubernetes Job `infra/k8s/jobs/provision-organisation.yaml`).
The command is idempotent on slug. It does not print a password or the
invitation token, and it does not give the operator a membership.

```bash
pnpm org:provision -- provision \
  --legal-name "Example Aboriginal Corporation" \
  --slug example-ac \
  --type council \
  --admin-email admin@example.org \
  --operator-email operator@blakpath.example
```

That creates the organisation with status `onboarding` and region
`ap-southeast-2`, clones system role templates except `platform-operator`,
seeds an empty readiness checklist, and emails the first administrator an
invite. The administrator chooses their own password from that link and must
enrol a passkey or authenticator before staff screens open.

Teams (Intake, Casework, Committee support) and groups are still created by
the organisation after sign-in, via `/settings/teams` or `POST /api/teams` and
`POST /api/groups`.

Checklist items are recorded by a person. The software does not mark them
complete. An organisation administrator can record items at
`PATCH /api/organisation/readiness`. The operator can record the same items:

```bash
pnpm org:provision -- readiness \
  --slug example-ac \
  --item consent_wording \
  --complete true \
  --operator-email operator@blakpath.example
```

Items: `consent_wording`, `evidence_requirements`, `teams`,
`administrator_mfa`, `escalation_contacts`.

## 1a. Signed agreement, then activation

A signed services agreement is required before status can become `active`
(the agreement document itself is counsel's work; see the contracts issue).
Record the reference the humans signed, then activate. Activation is refused
while any checklist item is open or the agreement reference is missing.
`publicApplicationsOpen` stays false until the organisation opens it.

```bash
pnpm org:provision -- agreement \
  --slug example-ac \
  --reference MSA-2026-014 \
  --signed-at 2026-10-01 \
  --operator-email operator@blakpath.example

pnpm org:provision -- activate \
  --slug example-ac \
  --operator-email operator@blakpath.example
```

If the invitation email fails, running `provision` again does nothing. Send the
link again with `resend-invite` and the same slug and operator email.

## 2. Identity

- Invite staff via membership invitations (hash-only tokens, verified email).
- Assign team/group memberships. Verify deny-by-default with
  `tests/e2e/team-isolation.spec.ts` against staging.
- Optional SSO: register provider (`src/lib/auth/sso-provider.ts`), add
  binding `POST /api/sso/providers`, verify domain in `organisation_domains`,
  then enable. SCIM maps onto membership status transitions.

## 3. Go live

1. Complete `docs/production-readiness.md` release gate in exact EKS images.
2. Run EKS restore drill (`docs/eks-runbook.md`), attach record.
3. Activate with `pnpm org:provision -- activate` once the readiness checklist
   and signed agreement are recorded. Open `publicApplicationsOpen` when ready.
4. Confirm audit chain clean, alarms firing to on-call, SES suppression flow
   wired (`POST /api/email/events` reachable from SNS).

## 4. Legacy import

Bulk imports run as privileged worker jobs with tenant binding, quarantined
evidence rescanned, every created record audited. No silent auto-determination:
imported matters enter at intake states only.
