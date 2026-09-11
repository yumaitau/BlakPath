'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { ClientRow } from '@/domains/teams';

/** Client register. Lists tenant clients, registers new ones. */
export function ClientRegister({ initial }: { initial: ClientRow[] }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setMessage('Enter client name.');
      return;
    }
    startTransition(async () => {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name.trim(),
          ...(email.trim() ? { contactEmail: email.trim() } : {}),
        }),
      });
      if (res.status === 403) {
        setMessage('No permission to register clients.');
        return;
      }
      if (!res.ok) {
        setMessage('Could not register client.');
        return;
      }
      setMessage('Client registered. Refresh to see them.');
      setName('');
      setEmail('');
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-muted-foreground text-sm">
          Client records belong to your council only. Never shared across tenants.
        </p>
      </div>
      <ul className="divide-y rounded-lg border" aria-label="Clients">
        {initial.length === 0 ? (
          <li className="text-muted-foreground p-3 text-sm">No clients yet.</li>
        ) : null}
        {initial.map((c) => (
          <li key={c.id} className="p-3 text-sm">
            <span className="font-medium">{c.displayName}</span>
            {c.contactEmail ? (
              <span className="text-muted-foreground"> · {c.contactEmail}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <form
        onSubmit={onCreate}
        className="flex flex-wrap items-end gap-2"
        aria-label="Register client"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="client-name" className="text-xs font-medium">
            Client name
          </label>
          <input
            id="client-name"
            className="rounded border px-2 py-1 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="client-email" className="text-xs font-medium">
            Contact email (optional)
          </label>
          <input
            id="client-email"
            type="email"
            className="rounded border px-2 py-1 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          Register client
        </Button>
      </form>
      {message ? (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
