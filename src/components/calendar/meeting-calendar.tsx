'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * RangerOS-parity calendar: month + week + agenda views, event creation with
 * resource-conflict feedback, plus `.ics` import/export. Times stored UTC,
 * displayed in viewer local zone. Committee meetings arrive as `events`;
 * general calendar events arrive as `calendarEvents` (same shape).
 */

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 start timestamp. */
  start: string;
  /** ISO 8601 end timestamp, if any. */
  end?: string | null;
  status: string;
  location?: string | null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type CalendarView = 'month' | 'week' | 'agenda';

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** Days (Mon-anchored) that make up the 6-week grid containing `month`. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

/** Monday-starting 7 days containing `anchor`. */
function weekDays(anchor: Date): Date[] {
  const offset = (anchor.getDay() + 6) % 7;
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MeetingCalendar({
  events,
  calendarEvents = [],
}: {
  events: CalendarEvent[];
  calendarEvents?: CalendarEvent[];
}) {
  const now = new Date();
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [mode, setMode] = useState<CalendarView>('month');
  const [weekAnchor, setWeekAnchor] = useState<Date>(now);
  const [pending, startTransition] = useTransition();
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState('');
  const [location, setLocation] = useState('');
  const [mounted, setMounted] = useState(false);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [moveId, setMoveId] = useState('');
  const [moveDate, setMoveDate] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Time-dependent display (today highlights, local-zone times) must only
  // render on client. Server/client clock or zone skew otherwise causes
  // hydration mismatch and spurious page errors in e2e.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount gate prevents SSR hydration mismatch on time-dependent display
    setMounted(true);
  }, []);

  const todayKey = ymd(now);
  const allEvents = useMemo(
    () => [...events, ...calendarEvents],
    [events, calendarEvents],
  );
  // Only general calendar events are movable via the events API; committee
  // meetings live in the meetings domain.
  const movableIds = useMemo(
    () => new Set(calendarEvents.map((e) => e.id)),
    [calendarEvents],
  );

  async function moveEvent(eventId: string, targetDay: Date): Promise<void> {
    const current = allEvents.find((e) => e.id === eventId);
    if (!current || !movableIds.has(eventId)) {
      setMoveMessage('Only calendar events can be moved; meetings stay put.');
      return;
    }
    const from = new Date(current.start);
    const to = new Date(targetDay);
    to.setHours(from.getHours(), from.getMinutes(), 0, 0);
    const shiftMs = to.getTime() - from.getTime();
    const end = current.end
      ? new Date(new Date(current.end).getTime() + shiftMs).toISOString()
      : null;
    try {
      const res = await fetch(`/api/calendar/events/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startAt: to.toISOString(),
          ...(end ? { endAt: end } : {}),
        }),
      });
      if (res.status === 409) {
        const data = (await res.json()) as { conflicts?: { title: string }[] };
        const names = (data.conflicts ?? []).map((c) => c.title).join(', ');
        setMoveMessage(`Blocked: resource already booked${names ? ` (${names})` : ''}.`);
        return;
      }
      if (res.status === 403) {
        setMoveMessage('No permission to move events.');
        return;
      }
      if (!res.ok) {
        setMoveMessage('Could not move event.');
        return;
      }
      setMoveMessage('Event moved. Refresh to see it.');
    } catch {
      setMoveMessage('Could not move event.');
    }
  }

  function onMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!moveId || !moveDate) {
      setMoveMessage('Choose event and new date.');
      return;
    }
    const [y, m, d] = moveDate.split('-').map(Number);
    if (!y || !m || !d) {
      setMoveMessage('Enter valid date.');
      return;
    }
    startTransition(async () => {
      await moveEvent(moveId, new Date(y, m - 1, d));
    });
  }

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of allEvents) {
      const key = ymd(new Date(event.start));
      const list = map.get(key);
      if (list) list.push(event);
      else map.set(key, [event]);
    }
    return map;
  }, [allEvents]);

  const agenda = useMemo(
    () =>
      [...allEvents]
        .sort((a, b) => +new Date(a.start) - +new Date(b.start))
        .slice(0, 100),
    [allEvents],
  );

  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);
  const week = useMemo(() => weekDays(weekAnchor), [weekAnchor]);

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function shiftWeek(delta: number) {
    setWeekAnchor((a) => {
      const d = new Date(a);
      d.setDate(a.getDate() + delta * 7);
      return d;
    });
  }

  async function onImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    startTransition(async () => {
      try {
        const res = await fetch('/api/calendar/import', {
          method: 'POST',
          headers: { 'Content-Type': 'text/calendar' },
          body: text,
        });
        if (!res.ok) {
          setImportMessage('Import failed. Check the file and your permissions.');
          return;
        }
        const data: { created?: number } = await res.json();
        setImportMessage(
          `Imported ${data.created ?? 0} meeting(s). Refresh to see them.`,
        );
      } catch {
        setImportMessage('Import failed.');
      } finally {
        if (fileInput.current) fileInput.current.value = '';
      }
    });
  }

  async function onCreateEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startAt) {
      setCreateMessage('Give event title and start time.');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            startAt: new Date(startAt).toISOString(),
            ...(location.trim() ? { location: location.trim() } : {}),
          }),
        });
        if (res.status === 401) {
          setCreateMessage('Sign in to create events.');
          return;
        }
        if (res.status === 403) {
          setCreateMessage('No permission to create events.');
          return;
        }
        if (!res.ok) {
          setCreateMessage('Could not create event. Check fields.');
          return;
        }
        const data: { conflicts?: unknown[] } = await res.json();
        const conflictCount = Array.isArray(data.conflicts) ? data.conflicts.length : 0;
        setCreateMessage(
          conflictCount > 0
            ? `Event created. Warning: ${conflictCount} resource conflict(s).`
            : 'Event created. Refresh to see it.',
        );
        setTitle('');
        setStartAt('');
        setLocation('');
      } catch {
        setCreateMessage('Could not create event.');
      }
    });
  }

  return (
    <section aria-label="Committee meeting calendar" className="flex flex-col gap-4">
      {!mounted ? (
        <p className="text-muted-foreground text-sm">Loading calendar…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {mode === 'month' ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => shiftMonth(-1)}
                    aria-label="Previous month"
                  >
                    ←
                  </Button>
                  <h2 className="min-w-48 text-center text-lg font-semibold tracking-tight">
                    {MONTH_NAMES[view.month]} {view.year}
                  </h2>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => shiftMonth(1)}
                    aria-label="Next month"
                  >
                    →
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setView({ year: now.getFullYear(), month: now.getMonth() })
                    }
                  >
                    Today
                  </Button>
                </>
              ) : mode === 'week' ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => shiftWeek(-1)}
                    aria-label="Previous week"
                  >
                    ←
                  </Button>
                  <h2 className="min-w-48 text-center text-lg font-semibold tracking-tight">
                    Week of {week[0]?.toLocaleDateString()}
                  </h2>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => shiftWeek(1)}
                    aria-label="Next week"
                  >
                    →
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setWeekAnchor(new Date())}
                  >
                    Today
                  </Button>
                </>
              ) : (
                <h2 className="text-lg font-semibold tracking-tight">
                  Agenda — next 100 events
                </h2>
              )}
            </div>

            <div
              className="flex items-center gap-2"
              role="group"
              aria-label="Calendar view"
            >
              {(['month', 'week', 'agenda'] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={mode === m ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                >
                  {m[0]?.toUpperCase() + m.slice(1)}
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href="/api/calendar/meetings" download>
                  Download calendar file
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => fileInput.current?.click()}
              >
                {pending ? 'Adding…' : 'Add calendar file'}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".ics,text/calendar"
                className="sr-only"
                aria-label="Upload calendar file"
                onChange={onImportFile}
              />
            </div>
          </div>

          {importMessage ? (
            <p role="status" className="text-muted-foreground text-sm">
              {importMessage}
            </p>
          ) : null}

          <form
            onSubmit={onCreateEvent}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
            aria-label="Create calendar event"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="cal-title" className="text-xs font-medium">
                Event title
              </label>
              <input
                id="cal-title"
                className="rounded border px-2 py-1 text-sm"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Intake clinic"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="cal-start" className="text-xs font-medium">
                Start
              </label>
              <input
                id="cal-start"
                type="datetime-local"
                className="rounded border px-2 py-1 text-sm"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="cal-location" className="text-xs font-medium">
                Location (optional)
              </label>
              <input
                id="cal-location"
                className="rounded border px-2 py-1 text-sm"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Council chambers"
              />
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Saving…' : 'Create event'}
            </Button>
            {createMessage ? (
              <p role="status" className="text-muted-foreground w-full text-sm">
                {createMessage}
              </p>
            ) : null}
          </form>

          {mode === 'agenda' ? (
            <ul className="divide-y rounded-lg border" aria-label="Agenda">
              {agenda.length === 0 ? (
                <li className="text-muted-foreground p-4 text-sm">No events yet.</li>
              ) : null}
              {agenda.map((event) => (
                <li
                  key={event.id}
                  className="flex items-baseline justify-between gap-3 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    <p className="text-muted-foreground text-xs">
                      {new Date(event.start).toLocaleString('en-AU')}
                      {event.location ? ` · ${event.location}` : ''}
                    </p>
                  </div>
                  <span className="text-muted-foreground text-xs">{event.status}</span>
                </li>
              ))}
            </ul>
          ) : mode === 'week' ? (
            <>
              <div className="grid grid-cols-7 gap-2" aria-label="Week view">
                {week.map((day) => {
                  const key = ymd(day);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  return (
                    <div
                      key={key}
                      className={cn(
                        'min-h-32 rounded-lg border p-2',
                        key === todayKey && 'border-primary',
                      )}
                      onDragOver={(e) => {
                        if (dragId) e.preventDefault();
                      }}
                      onDrop={() => {
                        if (dragId) {
                          const id = dragId;
                          setDragId(null);
                          startTransition(async () => {
                            await moveEvent(id, day);
                          });
                        }
                      }}
                    >
                      <p className="text-xs font-medium">
                        {day.toLocaleDateString('en-AU', {
                          weekday: 'short',
                          day: 'numeric',
                        })}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {dayEvents.map((event) => (
                          <li
                            key={event.id}
                            className="bg-primary/10 text-primary truncate rounded px-1.5 py-0.5 text-xs"
                            title={
                              movableIds.has(event.id)
                                ? `Drag to move: ${event.title}`
                                : event.title
                            }
                            draggable={movableIds.has(event.id)}
                            onDragStart={() => setDragId(event.id)}
                            onDragEnd={() => setDragId(null)}
                          >
                            {formatTime(event.start)} {event.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <form
                onSubmit={onMoveSubmit}
                className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
                aria-label="Move calendar event"
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="cal-move-event" className="text-xs font-medium">
                    Event
                  </label>
                  <select
                    id="cal-move-event"
                    className="rounded border px-2 py-1 text-sm"
                    value={moveId}
                    onChange={(e) => setMoveId(e.target.value)}
                  >
                    <option value="">Choose event…</option>
                    {calendarEvents.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="cal-move-date" className="text-xs font-medium">
                    New date
                  </label>
                  <input
                    id="cal-move-date"
                    type="date"
                    className="rounded border px-2 py-1 text-sm"
                    value={moveDate}
                    onChange={(e) => setMoveDate(e.target.value)}
                  />
                </div>
                <Button type="submit" size="sm" disabled={pending}>
                  Move event
                </Button>
                {moveMessage ? (
                  <p role="status" className="text-muted-foreground w-full text-sm">
                    {moveMessage}
                  </p>
                ) : null}
              </form>
            </>
          ) : (
            <div className="border-border overflow-hidden rounded-lg border">
              <div className="border-border bg-muted/40 grid grid-cols-7 border-b">
                {WEEKDAYS.map((day) => (
                  <div
                    key={day}
                    className="text-muted-foreground px-2 py-2 text-center text-xs font-medium"
                  >
                    {day}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((day) => {
                  const key = ymd(day);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  const inMonth = day.getMonth() === view.month;
                  const isToday = key === todayKey;
                  return (
                    <div
                      key={key}
                      className={cn(
                        'border-border min-h-24 border-r border-b p-1.5 last:border-r-0',
                        !inMonth && 'bg-muted/20 text-muted-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={cn(
                            'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs',
                            isToday && 'bg-primary text-primary-foreground font-semibold',
                          )}
                        >
                          {day.getDate()}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-1">
                        {dayEvents.map((event) => (
                          <li
                            key={event.id}
                            title={event.title}
                            className={cn(
                              'truncate rounded px-1.5 py-0.5 text-xs',
                              event.status === 'cancelled'
                                ? 'bg-muted text-muted-foreground line-through'
                                : 'bg-primary/10 text-primary',
                            )}
                          >
                            {formatTime(event.start)} {event.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
