# Council onboarding — new tenant in production

For deployment owners bringing a local council or community organisation onto
BlakPath. Data residency stays `ap-southeast-2` throughout.

## 1. Create tenant

`pnpm db:seed` loads the permission catalogue and system role templates only.
It does not create a production organisation. Do not insert the organisation
row by hand. Provision with the operator command (or the Kubernetes Job
`infra/k8s/jobs/provision-organisation.yaml`). `pnpm admin:invite`
(`infra/k8s/jobs/invite-admin.yaml`) still covers the very first organisation
on an empty database, but refuses once any organisation exists.

The command runs with the application database role (`DATABASE_URL`), never
the migrator. `--operator-email` must belong to a platform operator account;
the platform audit chain records that account's id, not the email. With
`NODE_ENV=production` every subcommand also needs `--confirm-production`
repeating the slug. The command is idempotent on slug. It does not print a
password or the invitation token, and it does not give the operator a
membership.

```bash
pnpm org:provision -- provision \
  --legal-name "Example Aboriginal Corporation" \
  --slug example-ac \
  --type council \
  --admin-email admin@example.org \
  --operator-email operator@blakpath.example \
  --confirm-production example-ac
```

That creates the organisation with status `onboarding`, applications closed and
region `ap-southeast-2`, clones system role templates except
`platform-operator`, seeds an empty readiness checklist, and emails the first
administrator an invite (SES in production). The organisation row, roles,
invitation and the platform audit event commit in one transaction. The
administrator chooses their own password from that link and must enrol a
passkey or authenticator before organisation tools open.

Teams (Intake, Casework, Committee support) and groups are still created by
the organisation after sign-in, via `/settings/teams` or `POST /api/teams` and
`POST /api/groups`. Consent wording and evidence requirements are recorded in
`organisation_settings`.

Checklist items are recorded by a person. The software does not mark them
complete. An organisation administrator can record items at
`PATCH /api/organisation/readiness`. The operator can record the same items:

```bash
pnpm org:provision -- readiness \
  --slug example-ac \
  --item consent_wording \
  --complete true \
  --operator-email operator@blakpath.example \
  --confirm-production example-ac
```

Items: `consent_wording`, `evidence_requirements`, `teams`,
`administrator_mfa`, `escalation_contacts`.

## 1a. Signed agreement

A signed services agreement is required before status can become `active`
through the operator command (the agreement document itself is counsel's
work; see the contracts issue). Record the reference the humans signed. The
reference stays on `organisation_settings`; the audit event records only that
it changed.

```bash
pnpm org:provision -- agreement \
  --slug example-ac \
  --reference MSA-2026-014 \
  --signed-at 2026-10-01 \
  --operator-email operator@blakpath.example \
  --confirm-production example-ac
```

If the invitation email fails, running `provision` again does nothing. Send the
link again with `resend-invite` and the same slug and operator email.

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
  the mail attribute. Staff must already be invited members.
- SCIM, if used, needs a per-organisation credential from
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
3. Activate once the tenant key is validated (section 2b), the readiness
   checklist is complete and the signed agreement is recorded:
   `pnpm org:provision -- activate --slug example-ac --operator-email ...
--confirm-production example-ac`. It refuses while any of the three is
   missing. An organisation admin can instead `POST /api/organisation/activation`
   (step-up), which checks the key only. Then open `publicApplicationsOpen`
   when ready. Platform operators suspend, close or reactivate with
   `POST /api/admin/organisations/{id}/status` (recent sign-in); the change is
   appended to the platform audit chain, and a move to `active` still needs a
   validated key.
4. Confirm audit chain clean, alarms firing to on-call, SES suppression flow
   wired (`POST /api/email/events` checks the pinned SNS topic) and the email
   checks in `docs/eks-runbook.md` passed (`dkim=pass spf=pass dmarc=pass`).

## 4. Legacy import

Bulk imports run as privileged worker jobs with tenant binding, quarantined
evidence rescanned, every created record audited. No silent auto-determination:
imported matters enter at intake states only.
