'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CollectionNotice as Notice } from '@/lib/privacy/collection-notice';
import { CollectionNotice } from '@/components/privacy/collection-notice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface RegisterApplication {
  id: string;
  reference: string;
  applicantName: string;
  status: string;
  priority: string;
  createdAt: string;
}

export interface RegisterParticipant {
  userId: string;
  name: string;
  email: string;
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A deliberately plain register: find a case, then take the next safe action. */
export function ApplicationRegister({
  applications,
  participants,
  canCreate,
  collectionNotice,
}: {
  applications: RegisterApplication[];
  participants: RegisterParticipant[];
  canCreate: boolean;
  /** The organisation's collection notice; staff attest it was given. */
  collectionNotice: Notice | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [priority, setPriority] = useState('normal');
  const [applicantUserId, setApplicantUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeGiven, setNoticeGiven] = useState(false);
  const [noticeInvalid, setNoticeInvalid] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return applications;
    return applications.filter(
      (application) =>
        application.reference.toLowerCase().includes(normalized) ||
        application.applicantName.toLowerCase().includes(normalized),
    );
  }, [applications, query]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy || !collectionNotice) return;
    if (!noticeGiven) {
      setNoticeInvalid(true);
      document.getElementById('application-collection-notice')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicantName: name,
          priority,
          applicantUserId: applicantUserId || undefined,
          collectionNotice: {
            version: collectionNotice.version,
            hash: collectionNotice.hash,
          },
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'You do not have access to start an application.'
            : response.status === 409
              ? 'The collection notice has changed. Reload the page, give the applicant the current notice, then try again.'
              : 'We could not start that application. Please try again.',
        );
        return;
      }
      const data = (await response.json()) as { application: { id: string } };
      router.push(`/applications/${data.application.id}`);
      router.refresh();
    } catch {
      setError(
        'We could not start that application. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <p className="text-muted-foreground text-sm font-medium">Case register</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Applications</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Find an existing matter or start a new record. BlakPath records the work your
            organisation does, it never makes a determination about a person.
          </p>
        </div>
        {canCreate && collectionNotice ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Start an application</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-4" onSubmit={create}>
                <div className="grid gap-2">
                  <Label htmlFor="applicant-name">Name as provided</Label>
                  <Input
                    id="applicant-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="applicant-account">Applicant account (optional)</Label>
                  <select
                    id="applicant-account"
                    value={applicantUserId}
                    onChange={(event) => setApplicantUserId(event.target.value)}
                    className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                  >
                    <option value="">Not linked yet</option>
                    {participants.map((participant) => (
                      <option key={participant.userId} value={participant.userId}>
                        {participant.name} ({participant.email})
                      </option>
                    ))}
                  </select>
                  <p className="text-muted-foreground text-xs">
                    Linking lets the applicant view this case and upload their own
                    evidence.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="application-priority">Handling priority</Label>
                  <select
                    id="application-priority"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <CollectionNotice
                  notice={collectionNotice}
                  id="application-collection-notice"
                  mode="staff_attested"
                  collapsible
                  headingLevel={4}
                  acknowledged={noticeGiven}
                  invalid={noticeInvalid}
                  onAcknowledgedChange={(given) => {
                    setNoticeGiven(given);
                    if (given) setNoticeInvalid(false);
                  }}
                />
                <Button type="submit" disabled={busy}>
                  {busy ? 'Starting…' : 'Start application'}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : null}
      </section>

      {error ? (
        <Alert tone="destructive" title="We couldn’t start the application">
          {error}
        </Alert>
      ) : null}

      <section
        aria-labelledby="application-register-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <h2 id="application-register-heading" className="text-lg font-semibold">
              Your visible applications
            </h2>
            <p className="text-muted-foreground text-sm">
              Results are limited to cases you are allowed to view.
            </p>
          </div>
          <div className="w-full sm:w-72">
            <Label htmlFor="application-search" className="sr-only">
              Search applications
            </Label>
            <Input
              id="application-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or reference"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-sm">
              No applications match this search. Start a new application when someone has
              asked your organisation for support.
            </CardContent>
          </Card>
        ) : (
          <ul className="border-border divide-border divide-y overflow-hidden rounded-lg border">
            {filtered.map((application) => (
              <li key={application.id}>
                <Link
                  href={`/applications/${application.id}`}
                  className="hover:bg-surface-muted focus-visible:ring-ring flex flex-col gap-2 px-4 py-4 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset sm:flex-row sm:items-center sm:justify-between"
                >
                  <span>
                    <span className="block font-semibold">
                      {application.applicantName}
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {application.reference}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-sm sm:text-right">
                    <span className="text-foreground block font-medium">
                      {label(application.status)}
                    </span>
                    <span>{label(application.priority)} priority</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
