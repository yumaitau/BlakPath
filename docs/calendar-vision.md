# Calendar vision — RangerOS parity

Current: meetings-only month grid + `.ics` import/export
(`src/components/calendar/meeting-calendar.tsx`, `src/lib/calendar/ics.ts`).
Target: fully featured calendar, RangerOS gold standard.

## Views

Month (42-day Mon-anchored grid), week (time-grid 15-min slots),
day (single-column schedule), agenda (chronological list, grouping by day).
Keyboard-operable, WCAG 2.2 AA, reduced-motion respected, local-zone display,
UTC storage.

## Data model

`calendar_events` tenant-owned, org-leading indexes. Fields: title,
description, location, resource (room/vehicle), start/end timestamptz,
all-day, `rrule` RFC 5545 string, `timezone`, `status`
(scheduled/cancelled/completed), optional `meetingId` link, soft delete.
`calendar_event_attendees`: user/email, response
(needs-action/accepted/declined/tentative). `calendar_event_reminders`:
minutes-before + channel (in-app/email).

Recurrence: store master `rrule`, expand occurrences in service layer
(never materialise infinite series). Imports map VEVENT RRULE into `rrule`;
exports emit RRULE + EXDATE.

## Interactions

Create/edit/delete with permission keys (`calendar:create/update-any/delete-any`).
Drag-drop to reschedule (optimistic UI + server confirm + audit).
Attendee invites, conflict check (overlapping resource/attendee warn),
reminders via BullMQ + notifications domain. ICS sync both ways, 1 MiB cap
kept. Meeting pack link when `meetingId` set.

## Non-goals

No auto-scheduling by identity signal. No availability scoring by applicant.
Calendar never influences CoA outcome. Human authority stays visible.

## Build order

1. Schema + migration (this change).
2. Service: CRUD + RRULE expand + conflict check + ICS map.
3. API: `/api/calendar/events` CRUD, `/api/calendar/meetings` kept.
4. UI: agenda first, then week/day, then drag-drop + resources.
5. E2E: `tests/e2e/calendar-journeys.spec.ts`.
