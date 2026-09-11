'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Invitation manager for a form.
 *
 * Staff mint a tokenised link for a named recipient. The link's raw token is
 * returned by the server exactly once, so we show the generated URL with a Copy
 * control and a plain note that it will not be shown again. Existing invitations
 * are listed with their status and a Revoke control.
 *
 * PRODUCT INVARIANT: an invitation is just a shareable link to collect a human's
 * answers. It never determines a person's Aboriginality.
 */

export interface InvitationListItem {
  id: string;
  recipientName: string | null;
  recipientEmail: string | null;
  status: string;
  expiresAt: string | null;
}

interface FormInvitationsProps {
  formId: string;
  initialInvitations: InvitationListItem[];
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Not opened',
  opened: 'Opened',
  completed: 'Completed',
  revoked: 'Revoked',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry';
  // Pinned locale: server and browser defaults differ (en-AU vs en-US),
  // which caused hydration mismatch. Australian format is correct for product.
  return `Expires ${new Date(expiresAt).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

export function FormInvitations({ formId, initialInvitations }: FormInvitationsProps) {
  const [invitations, setInvitations] =
    useState<InvitationListItem[]>(initialInvitations);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('14');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGeneratedUrl(null);
    setCopied(false);
    setCreating(true);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const days = Number.parseInt(expiresInDays, 10);

    try {
      const res = await fetch(`/api/forms/${formId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(trimmedName.length > 0 ? { recipientName: trimmedName } : {}),
          ...(trimmedEmail.length > 0 ? { recipientEmail: trimmedEmail } : {}),
          ...(Number.isFinite(days) ? { expiresInDays: days } : {}),
        }),
      });
      if (!res.ok) {
        setError('Could not create the invitation. Please check the details.');
        return;
      }
      const data = (await res.json()) as {
        invitation: {
          id: string;
          recipientName: string | null;
          recipientEmail: string | null;
          status: string;
          expiresAt: string | null;
        };
        url: string;
      };
      setGeneratedUrl(data.url);
      setInvitations((current) => [
        {
          id: data.invitation.id,
          recipientName: data.invitation.recipientName,
          recipientEmail: data.invitation.recipientEmail,
          status: data.invitation.status,
          expiresAt: data.invitation.expiresAt,
        },
        ...current,
      ]);
      setName('');
      setEmail('');
    } catch {
      setError('Could not create the invitation. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  async function onCopy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/forms/invitations/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setError('Could not revoke the invitation. Please try again.');
        return;
      }
      setInvitations((current) =>
        current.map((inv) => (inv.id === id ? { ...inv, status: 'revoked' } : inv)),
      );
    } catch {
      setError('Could not revoke the invitation. Please try again.');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={onCreate} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-name">Recipient name</Label>
            <Input
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-email">Recipient email</Label>
            <Input
              id="inv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-expiry">Expires in (days)</Label>
            <Input
              id="inv-expiry"
              type="number"
              min={1}
              max={90}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Button type="submit" size="sm" disabled={creating}>
            {creating ? 'Creating…' : 'Create invitation'}
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      ) : null}

      {generatedUrl ? (
        <div className="border-border bg-muted flex flex-col gap-2 rounded-md border p-3">
          <p className="text-foreground text-sm font-medium">Invitation link created</p>
          <p className="text-muted-foreground text-xs">
            Copy this link now — it is shown once and cannot be retrieved again.
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={generatedUrl} aria-label="Invitation link" />
            <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-primary text-sm font-semibold">Invitations</h3>
        {invitations.length === 0 ? (
          <p className="text-muted-foreground text-sm">No invitations yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="border-border bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground text-sm font-medium">
                    {inv.recipientName ?? inv.recipientEmail ?? 'Unnamed recipient'}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {statusLabel(inv.status)} · {formatExpiry(inv.expiresAt)}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn('text-destructive')}
                  disabled={inv.status === 'revoked' || inv.status === 'completed'}
                  onClick={() => onRevoke(inv.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
