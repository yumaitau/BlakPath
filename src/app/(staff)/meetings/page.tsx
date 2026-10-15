import {
  MeetingCalendar,
  type CalendarEvent,
} from '@/components/calendar/meeting-calendar';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { ScheduleMeetingForm } from '@/components/meetings/schedule-meeting-form';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listMeetings } from '@/domains/meetings';
import { listCalendarEvents } from '@/domains/calendar';
import { hasPermission, subjectFromContext } from '@/lib/permissions/check';

/**
 * Committee meetings + general calendar (RSC).
 *
 * Loads meetings and calendar events inside DB-verified tenant context and
 * renders month/week/agenda views with `.ics` import/export. An expired session
 * or missing organisation redirects; a role without access sees a 403 state;
 * anything else surfaces as the 500 error page.
 */
export default async function MeetingsPage() {
  let events: CalendarEvent[];
  let calendarEvents: CalendarEvent[];
  let canCreate: boolean;
  try {
    const data = await withRequestTenant(async (ctx) => {
      const meetings = await listMeetings().catch(() => []);
      const cal = await listCalendarEvents().catch(() => []);
      return {
        canCreate: hasPermission(subjectFromContext(ctx), 'meeting:create'),
        meetings: meetings.map((m) => ({
          id: m.id,
          title: m.title,
          start: m.scheduledStart.toISOString(),
          end: m.scheduledEnd ? m.scheduledEnd.toISOString() : null,
          status: m.status,
          href: `/meetings/${m.id}`,
        })),
        cal: cal.map((e) => ({
          id: e.id,
          title: e.title,
          start: e.startAt.toISOString(),
          end: e.endAt ? e.endAt.toISOString() : null,
          status: e.status,
          location: e.location,
        })),
      };
    });
    events = data.meetings;
    calendarEvents = data.cal;
    canCreate = data.canCreate;
  } catch (error) {
    await handlePageError(error);
    return <ForbiddenNotice title="You do not have access to committee meetings" />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Committee meetings</h1>
      <div className="flex flex-col gap-8">
        {/* Calendar entries for committee meetings link to the sitting. */}
        <MeetingCalendar events={events} calendarEvents={calendarEvents} />
        {canCreate ? <ScheduleMeetingForm /> : null}
      </div>
    </div>
  );
}
