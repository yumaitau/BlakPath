# E2E user journeys

Playwright, chromium, one worker. `pnpm test:e2e` runs `tests/e2e` against
`next dev` locally. With `PLAYWRIGHT_SERVER=production` it serves an existing
`pnpm build` output with `next start`; CI does that. `pnpm test:e2e:smoke`
runs `tests/e2e-smoke` through `playwright.smoke.config.ts` against an already
running production `runner` image (set `PLAYWRIGHT_BASE_URL`). The image runs
the production release gate at boot and refuses to start without real KMS, SES
and managed S3, so point it at staging. CI does not run it.

Helpers: `tests/e2e/helpers/auth.ts` (isolated client IP, Origin header,
cookie reuse), `tests/e2e/helpers/accessibility.ts` (axe, WCAG 2.2 AA),
`tests/e2e/helpers/page.ts` (fails a test on a CSP violation),
`tests/e2e/helpers/page-errors.ts`. Each spec below
watches `pageerror` and runs the axe helper on a primary view.

Evidence upload needs object storage. Set `RUN_EVIDENCE_E2E=true` and point
S3 at MinIO or staging buckets. Without that flag the evidence step skips.
CI sets the flag and starts MinIO.

## auth-onboarding.spec.ts

- anonymous sign-in gate keeps the destination (`returnTo`)
- branded 404
- sign-up stays invite-only
- verify-email gate
- sign-in and org picker
- sign-out session end

## core-staff-flow.spec.ts

- wrong-password generic error
- evidence upload quarantine

## product-workflows.spec.ts

- bootstrap passkey listed
- MFA fail-safe

## membership-lifecycle.spec.ts

- invite accept

## coa-lifecycle.spec.ts

- dashboard loads with attention items
- board task persists across reload
- applications list is tenant-scoped
- meetings calendar renders
- no auto-determination UI

## coa-sealed-lifecycle.spec.ts

- application intake
- review create and finalise
- decision propose vote and finalise
- human outcome is an explicit recorded act
- certificate generate sign and download
- public verify

## team-isolation.spec.ts

- anonymous tenant APIs deny
- council A cannot read council B
- team-assigned read vs unassigned deny
- group list stays inside the tenant
- invitation email-mismatch deny

## calendar-journeys.spec.ts

- month navigation
- create event
- week view
- agenda view
- reschedule persists across reload
- ICS import and export
- recurring RRULE round-trip
- attendee invite and response
- reminder set
- resource conflict warning

## sso-consent.spec.ts

- SSO bindings gating
- consent gate on representative access
- SCIM-off denial without enumeration

## sso-sign-in.spec.ts

Federated sign-in against an in-test mock Entra-style IdP (PKCE + nonce
enforced). Needs `SSO_ENTRA_CLIENT_ID`, `SSO_ENTRA_CLIENT_SECRET`,
`SSO_STATE_SECRET` (mock values; CI sets them) or it skips.

- disabled binding denied with a generic error and audited
- sign-in lands in the bound tenant with permissions unchanged
- forged nonce denied and audited
- callback without the browser-bound flow cookie refused

## applicant-portal.spec.ts

- public directory lists opted-in organisations and blocks a closed start
- applicant sees only their own case and never the staff shell

## audit-log.spec.ts

- administrator reads the audit trail and records the monthly review

## content-security.spec.ts

- HTML responses carry a fresh content security policy
- cookie API mutations reject a foreign origin and a non-JSON body

## staff-mfa.spec.ts

- staff without a verified factor is sent to enrolment

## production-smoke.spec.ts

- production image health and liveness
- production image serves sign-in

Seed creates a second council (`dev-org-b`) and an org A team fixture. Isolation
steps use those rows. Outcomes stay recorded human acts. Nothing in these
journeys scores, ranks, or decides identity.

No separate day view. Week view shows each day. No committee meeting agenda
HTTP route. Meetings are the calendar and ICS import. The invitation email-mismatch step asserts the 403 denial the
service records. Reschedule uses the week-view Move control, which calls the
same `moveEvent` handler as dragging an event. HTML5 drag is not automated.
Resource overlap warns (201 plus a conflicts list) unless the hard-block flag
is on.
