'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** Schedule a committee meeting. Does not create a general calendar event. */
export function ScheduleMeetingForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [scheduledEnd, setScheduledEnd] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          scheduledStart: new Date(scheduledStart).toISOString(),
          ...(scheduledEnd ? { scheduledEnd: new Date(scheduledEnd).toISOString() } : {}),
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'Your role cannot schedule meetings.'
            : 'The meeting could not be scheduled. Check the times and try again.',
        );
        return;
      }
      const body = (await response.json()) as { meeting?: { id?: string } };
      if (!body.meeting?.id) {
        setError('The meeting could not be scheduled.');
        return;
      }
      router.push(`/meetings/${body.meeting.id}`);
      router.refresh();
    } catch {
      setError(
        'The meeting could not be scheduled. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border-border grid gap-4 rounded-xl border p-4"
      aria-labelledby="schedule-meeting-heading"
    >
      <h2 id="schedule-meeting-heading" className="text-lg font-semibold">
        Schedule a committee meeting
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="meeting-title">Title</Label>
          <Input
            id="meeting-title"
            className="mt-2"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
          />
        </div>
        <div>
          <Label htmlFor="meeting-start">Starts</Label>
          <Input
            id="meeting-start"
            className="mt-2"
            type="datetime-local"
            value={scheduledStart}
            onChange={(event) => setScheduledStart(event.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="meeting-end">Ends (optional)</Label>
          <Input
            id="meeting-end"
            className="mt-2"
            type="datetime-local"
            value={scheduledEnd}
            onChange={(event) => setScheduledEnd(event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="meeting-location">Location (optional)</Label>
          <Input
            id="meeting-location"
            className="mt-2"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            maxLength={300}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="meeting-notes">Notes (optional)</Label>
          <Textarea
            id="meeting-notes"
            className="mt-2"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={5000}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="w-fit">
        {busy ? 'Scheduling…' : 'Schedule meeting'}
      </Button>
    </form>
  );
}
