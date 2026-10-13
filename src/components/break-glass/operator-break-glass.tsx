'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface OperatorGrantItem {
  id: string;
  organisationId: string;
  status: string;
  supportCaseRef: string;
  purpose: string;
  scope: string;
  expiresAt: string | null;
  reviewDueAt: string | null;
  tenantNotifiedAt: string | null;
}

interface ApplicationView {
  id: string;
  reference: string;
  applicantName: string;
  status: string;
}

async function readError(response: Response): Promise<string> {
  if (response.status === 401) return 'Sign in again to confirm this action.';
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? 'That action could not be completed.';
}

/** Platform operator console: request, activate, and read under a live grant. */
export function OperatorBreakGlass({
  initialItems,
}: {
  initialItems: OperatorGrantItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [organisationId, setOrganisationId] = useState('');
  const [supportCaseRef, setSupportCaseRef] = useState('');
  const [purpose, setPurpose] = useState('');
  const [scope, setScope] = useState('');
  const [expiresInMinutes, setExpiresInMinutes] = useState('60');
  const [openGrantId, setOpenGrantId] = useState<string | null>(null);
  const [applications, setApplications] = useState<ApplicationView[]>([]);

  async function reload() {
    const response = await fetch('/api/break-glass/mine');
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    const payload = (await response.json()) as { items: OperatorGrantItem[] };
    setItems(payload.items);
  }

  async function requestAccess(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organisationId,
          supportCaseRef,
          purpose,
          scope,
          expiresInMinutes: Number(expiresInMinutes),
        }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      setOrganisationId('');
      setSupportCaseRef('');
      setPurpose('');
      setScope('');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/break-glass/${id}/activate`, { method: 'POST' });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function openAccess(id: string) {
    setBusy(true);
    setError(null);
    setOpenGrantId(id);
    setApplications([]);
    try {
      const response = await fetch(`/api/break-glass/${id}/access/applications`);
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const payload = (await response.json()) as { items: ApplicationView[] };
      setApplications(payload.items);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      {error ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request emergency access</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void requestAccess(event)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bg-org">Organisation id</Label>
              <Input
                id="bg-org"
                value={organisationId}
                onChange={(event) => setOrganisationId(event.target.value)}
                required
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-case">Support case</Label>
              <Input
                id="bg-case"
                value={supportCaseRef}
                onChange={(event) => setSupportCaseRef(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-purpose">Purpose</Label>
              <Textarea
                id="bg-purpose"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-scope">What you need to read</Label>
              <Textarea
                id="bg-scope"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-minutes">Minutes until expiry</Label>
              <Input
                id="bg-minutes"
                type="number"
                min={5}
                max={480}
                value={expiresInMinutes}
                onChange={(event) => setExpiresInMinutes(event.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={busy}>
              Request access
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No requests yet.</p>
        ) : null}
        {items.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <CardTitle className="text-base">
                {item.supportCaseRef} · {item.status}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p>{item.purpose}</p>
              <p className="text-muted-foreground">
                Organisation {item.organisationId}. Notified:{' '}
                {item.tenantNotifiedAt ? 'yes' : 'no'}.
              </p>
              <div className="flex flex-wrap gap-2">
                {item.status === 'approved' ? (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void activate(item.id)}
                  >
                    Activate
                  </Button>
                ) : null}
                {item.status === 'active' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void openAccess(item.id)}
                  >
                    Read applications
                  </Button>
                ) : null}
              </div>
              {openGrantId === item.id ? (
                <ul className="grid gap-1">
                  {applications.length === 0 ? (
                    <li className="text-muted-foreground">
                      No applications in this read.
                    </li>
                  ) : (
                    applications.map((application) => (
                      <li key={application.id}>
                        {application.reference} · {application.applicantName} ·{' '}
                        {application.status}
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
