# Assisted review guide — human sessions with representative users

Automation (axe, Playwright) cannot judge trauma-awareness, plain-language
clarity, or real assistive-tech behaviour. Run assisted sessions before any
production release handling real records.

## Participants

- 3–5 representative non-technical staff (intake, casework, committee).
- Screen reader (VoiceOver/NVDA), keyboard-only, 200% text scaling, reduced motion.
- Facilitator + note-taker; consent recorded for session notes.

## Journey scripts

1. Sign in with passkey, pick organisation, reach dashboard.
2. Intake: start application, upload evidence, assign to caseworker.
3. Board: move task, verify dashboard reflects change.
4. Meetings/calendar: import ICS, create event, move it in week view, read agenda.
5. Teams/clients: create team, register client, assign.
6. Forms: author, publish, complete via invitation link as applicant.
7. Security: enrol TOTP, sign out, sign back in.

## Record

Use `docs/assisted-usability-review-template.md` per session. Log findings in
`docs/accessibility-acceptance.md` with severity, owner, fix, and the e2e or
unit test locking each fix. No production go-live with open critical findings.
