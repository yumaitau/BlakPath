# Accessibility acceptance

BlakPath targets WCAG 2.2 AA for public, applicant and staff journeys. Automated
checks are a release gate, not a substitute for testing with people who use
assistive technology or for an assisted review with representative
non-technical users.

## Automated release gate

`pnpm test:e2e` runs axe against these supported journeys in Chromium:

- public landing, accessibility, privacy, support, organisation discovery and
  certificate verification;
- sign in, sign up, password reset and organisation selection;
- dashboard, application register and case view, work board, forms and the
  notifications menu;
- keyboard-only notification-menu use, task creation and movement, form
  creation, and public form completion;
- committee calendar import/view/export, membership lifecycle controls and
  account-security failure/sign-out journeys;
- chart accessible names, visible keyboard focus, status announcements, errors
  and focus transfer after successful form submission.

The test fails for any axe violation tagged WCAG 2 A/AA, WCAG 2.1 AA or WCAG
2.2 AA. CI runs the suite on every pull request to `main`.

## Manual screen-reader and keyboard check

Before a broad rollout, test the current release with VoiceOver and Safari on
macOS or iOS, and NVDA and Chrome on Windows where available. Use only the
keyboard or the screen reader's standard navigation commands.

Record whether the reviewer can:

1. skip repeated navigation and identify the page, primary navigation and main
   content;
2. sign in, understand a generic authentication error and select an
   organisation;
3. identify the active organisation, open and close both header menus, and
   understand unread notification state;
4. find and open an application and understand its reference, state and human
   decision history;
5. create a task and move it between board columns, including understanding the
   drag instructions and result announcement;
6. complete and submit a public form, correct an error and hear the success
   confirmation;
7. understand every dashboard chart from its accessible name without relying
   on colour, shape or position.

## Assisted usability review record

The product owner arranges a short review with representative non-technical
staff before broad rollout. Participation must be voluntary, use synthetic
records only and avoid asking participants to disclose personal or community
information. At least one session should include keyboard or screen-reader use
if a willing participant uses that access method.

| Field          | Record                                      |
| -------------- | ------------------------------------------- |
| Owner          | Product owner                               |
| Target date    | Before broad rollout                        |
| Status         | Pending representative-user scheduling      |
| Release effect | Broad rollout remains gated until completed |

For each finding, record the journey, observed difficulty, participant impact,
severity, owner, target date and follow-up issue. Do not identify participants
in the repository. Start from
[`assisted-usability-review-template.md`](assisted-usability-review-template.md)
and the session scripts in [`assisted-review-guide.md`](assisted-review-guide.md)
so every observation is consistently triaged.

## Known exceptions

| Exception                                     | Impact                                                                                | Owner                          | Target date          |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ | -------------------- |
| Assisted review has not yet been conducted    | Automated checks cannot validate plain-language comprehension or real-world usability | Product owner                  | Before broad rollout |
| Automated browser coverage is Chromium-only   | Engine and platform accessibility differences may be missed                           | Engineering owner              | Before broad rollout |
| Screen-reader checks require a human reviewer | Axe cannot verify announcement quality or reading order in a real screen reader       | Product and engineering owners | Before broad rollout |

Any new exception must name an owner and a concrete target date or release
milestone. WCAG A/AA failures on a supported journey are release blockers.
