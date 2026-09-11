# E2E user journeys — full matrix

Runner: Playwright, `tests/e2e`, chromium, single worker. Helpers:
`tests/e2e/helpers/auth.ts` (isolated client IP, cookie reuse),
`tests/e2e/helpers/accessibility.ts` (axe WCAG 2.2 AA).

## Environment gates

- Evidence upload journey requires real object storage: run with
  `RUN_EVIDENCE_E2E=true` against local MinIO (`docker compose up minio
minio-init`) or S3 staging buckets. Without it the test skips; the path is
  covered in staging per `docs/eks-runbook.md`.

## Suites

1. `auth-onboarding.spec.ts` — sign-up, verify-email gate, sign-in,
   wrong-password generic error, MFA fail-safe, passkey empty state,
   org picker, invite accept, sign-out session end (401 + redirect).
2. `coa-lifecycle.spec.ts` — application intake, evidence upload quarantine,
   review create/finalise, meeting agenda, decision propose/vote/finalise,
   certificate generate/sign/download, public verify path. Asserts human-only
   determination (no auto-approve UI/API).
3. `team-isolation.spec.ts` — council A vs council B: no cross-read,
   team-assigned read vs unassigned deny, group scoping, invitation
   email-mismatch deny, audit log records denials.
4. `calendar-journeys.spec.ts` — create event, week/day/agenda views,
   recurring RRULE expand, attendee invite/response, reminder set,
   drag reschedule persist + reload, ICS import/export round-trip,
   resource conflict warning.
5. `sso-consent.spec.ts` — SSO bindings gating, consent gate on
   representative access, SCIM-off denial without enumeration.
6. Existing kept: `core-staff-flow`, `product-workflows`,
   `membership-lifecycle`, `api-boundaries`, `accessibility`.

## Rules

Each test: fresh stamp titles, `watchForPageErrors` empty, axe check on
primary view, tenant isolation assert (second org cannot fetch first org id),
audit spot-check where sensitive. No hard-coded prod secrets. Live stack
variant stays in `tests/live`, gated by env.
