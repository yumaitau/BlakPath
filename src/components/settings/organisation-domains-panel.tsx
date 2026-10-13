'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrganisationDomainView } from '@/domains/organisation-settings';

type Notice = { tone: 'ok' | 'err'; text: string } | null;

async function readError(response: Response): Promise<string> {
  if (response.status === 403) return 'No permission for that action.';
  if (response.status === 400 || response.status === 409 || response.status === 503) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === 'Invalid request') {
      return 'Enter a domain like council.example.gov.au.';
    }
    if (typeof body?.error === 'string' && body.error.length > 0) return body.error;
  }
  return 'Could not update domains. Try again.';
}

/** Claim a DNS domain and prove control with the TXT record BlakPath shows. */
export function OrganisationDomainsPanel({
  initialDomains,
}: {
  initialDomains: OrganisationDomainView[];
}) {
  const [domains, setDomains] = useState(initialDomains);
  const [domainName, setDomainName] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function addDomain(event: React.FormEvent) {
    event.preventDefault();
    setPending('add');
    setNotice(null);
    try {
      const response = await fetch('/api/organisation-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainName }),
      });
      if (!response.ok) {
        setNotice({ tone: 'err', text: await readError(response) });
        return;
      }
      const body = (await response.json()) as { domain: OrganisationDomainView };
      setDomains((current) =>
        [...current, body.domain].sort((a, b) => a.domain.localeCompare(b.domain)),
      );
      setDomainName('');
      setNotice({
        tone: 'ok',
        text: 'Domain added. Publish the TXT record, then check it.',
      });
    } finally {
      setPending(null);
    }
  }

  async function checkDomain(id: string) {
    setPending(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/organisation-domains/${id}/verify`, {
        method: 'POST',
      });
      if (!response.ok) {
        setNotice({ tone: 'err', text: await readError(response) });
        return;
      }
      const body = (await response.json()) as { domain: OrganisationDomainView };
      setDomains((current) =>
        current.map((item) => (item.id === id ? body.domain : item)),
      );
      setNotice({ tone: 'ok', text: `${body.domain.domain} is verified.` });
    } finally {
      setPending(null);
    }
  }

  async function removeDomain(id: string) {
    setPending(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/organisation-domains/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        setNotice({ tone: 'err', text: await readError(response) });
        return;
      }
      setDomains((current) => current.filter((item) => item.id !== id));
      setConfirmRemove(null);
      setNotice({
        tone: 'ok',
        text: 'Domain removed. Any SSO binding on it was turned off.',
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="border-border rounded-lg border p-4 sm:p-5"
      aria-labelledby="domains-heading"
    >
      <h2 id="domains-heading" className="text-lg font-semibold">
        Domains
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">
        SSO can be enabled only for a domain this organisation has verified. Publish the
        TXT record at your DNS host, then check it here. BlakPath does not change DNS for
        you.
      </p>

      {domains.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">No domains yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {domains.map((item) => (
            <li key={item.id} className="border-border rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{item.domain}</p>
                <p className="text-sm">{item.verified ? 'Verified' : 'Not verified'}</p>
              </div>
              {item.dns ? (
                <dl className="mt-3 grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">TXT host</dt>
                    <dd>
                      <code className="break-all">{item.dns.host}</code>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">TXT value</dt>
                    <dd>
                      <code className="break-all">{item.dns.value}</code>
                    </dd>
                  </div>
                </dl>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {!item.verified ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => checkDomain(item.id)}
                  >
                    {pending === item.id ? 'Checking…' : 'Check DNS'}
                  </Button>
                ) : null}
                {confirmRemove === item.id ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending !== null}
                    onClick={() => removeDomain(item.id)}
                  >
                    Confirm remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => setConfirmRemove(item.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={addDomain}
        className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="grid flex-1 gap-2">
          <Label htmlFor="organisation-domain">Add a domain</Label>
          <Input
            id="organisation-domain"
            value={domainName}
            onChange={(event) => setDomainName(event.target.value)}
            placeholder="council.example.gov.au"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <Button type="submit" size="sm" disabled={pending !== null}>
          {pending === 'add' ? 'Adding…' : 'Add domain'}
        </Button>
      </form>

      {notice ? (
        <p
          role={notice.tone === 'err' ? 'alert' : 'status'}
          className={
            notice.tone === 'err' ? 'text-destructive mt-3 text-sm' : 'mt-3 text-sm'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
