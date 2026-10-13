# E2E user journeys

Playwright, chromium, one worker. `pnpm test:e2e` runs `tests/e2e` against
`next dev`. `pnpm test:e2e:smoke` runs `tests/e2e-smoke` through
`playwright.smoke.config.ts` against an already running production `runner`
container. CI job `e2e-smoke` builds that image and starts it. The full suite
stays on `next dev`.

Helpers: `tests/e2e/helpers/auth.ts`, `tests/e2e/helpers/accessibility.ts`
(axe, WCAG 2.2 AA), `tests/e2e/helpers/page-errors.ts`. Each spec below
watches `pageerror` and runs the axe helper on a primary view.

Evidence upload needs object storage. Set `RUN_EVIDENCE_E2E=true` and point
S3 at MinIO or staging buckets. Without that flag the evidence step skips.
CI sets the flag and starts MinIO.

## auth-onboarding.spec.ts

- sign-up stays invite-only
- verify-email gate
- sign-in and org picker
- sign-out session end

## core-staff-flow.spec.ts

- wrong-password generic error
- evidence upload quarantine

## product-workflows.spec.ts

- passkey empty state
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

## production-smoke.spec.ts

- production image health and liveness
- production image serves sign-in

Seed creates a second council (`dev-org-b`) and an org A team fixture. Isolation
steps use those rows. Outcomes stay recorded human acts. Nothing in these
journeys scores, ranks, or decides identity.

No separate day view. Week view shows each day. No committee meeting agenda
HTTP route. Meetings are the calendar and ICS import. No staff screen reads
the audit log. The invitation email-mismatch step asserts the 403 denial the
service records. Reschedule uses the week-view Move control, which calls the
same `moveEvent` handler as dragging an event. HTML5 drag is not automated.
Resource overlap warns (201 plus a conflicts list) unless the hard-block flag
is on.
