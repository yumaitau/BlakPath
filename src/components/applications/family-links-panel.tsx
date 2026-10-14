'use client';

import { CheckCircle2, CircleDot, Eye, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/hooks/use-hydrated';

export interface FamilyLinkPanelItem {
  id: string;
  relationship: string;
  relativeName: string;
  community: string | null;
  notes: string | null;
  relativeDeceased: boolean;
  status: string;
  requestedByUserId: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface FamilyLinksPanelProps {
  applicationId: string;
  currentUserId: string;
  deceasedWarning: string;
  links: FamilyLinkPanelItem[];
  permissions: {
    request: boolean;
    approve: boolean;
  };
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: string): 'success' | 'warning' | 'info' | 'neutral' {
  if (status === 'approved') return 'success';
  if (status === 'disputed') return 'warning';
  if (status === 'requested') return 'info';
  return 'neutral';
}

function statusIcon(status: string) {
  if (status === 'approved') return CheckCircle2;
  if (status === 'disputed') return TriangleAlert;
  return CircleDot;
}

/**
 * Case-page family links.
 *
 * A genealogy officer records a connection. A different person approves or
 * disputes it. When the relative has passed, the name stays out of the page
 * until someone chooses to show it after the warning.
 */
export function FamilyLinksPanel({
  applicationId,
  currentUserId,
  deceasedWarning,
  links,
  permissions,
}: FamilyLinksPanelProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [relationship, setRelationship] = useState('');
  const [relativeName, setRelativeName] = useState('');
  const [community, setCommunity] = useState('');
  const [notes, setNotes] = useState('');
  const [relativeDeceased, setRelativeDeceased] = useState(false);

  async function send(
    key: string,
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    success: string,
  ): Promise<boolean> {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'That action was refused. A different person must approve or dispute a link, and your role must allow it.'
            : 'That record could not be saved. Refresh the case and try again.',
        );
        return false;
      }
      setMessage(success);
      router.refresh();
      return true;
    } catch {
      setError('That record could not be saved. Check your connection and try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="family-links-heading"
      className="border-border border-t pt-8"
    >
      <div className="max-w-3xl">
        <p className="text-muted-foreground text-sm font-medium">Genealogy</p>
        <h2 id="family-links-heading" className="mt-1 text-xl font-semibold">
          Family links
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Record a specific family connection. Approving or disputing it is a separate
          person&apos;s act. BlakPath does not decide Aboriginality.
        </p>
      </div>

      {error ? (
        <Alert className="mt-5" role="alert" tone="destructive" title="Record not saved">
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert className="mt-5" tone="success">
          {message}
        </Alert>
      ) : null}

      {links.length === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm">
          No family link has been recorded for this case.
        </p>
      ) : (
        <ul className="divide-border mt-6 divide-y">
          {links.map((link) => (
            <FamilyLinkItem
              key={link.id}
              link={link}
              applicationId={applicationId}
              currentUserId={currentUserId}
              deceasedWarning={deceasedWarning}
              permissions={permissions}
              busy={busy}
              hydrated={hydrated}
              onSend={send}
            />
          ))}
        </ul>
      )}

      {permissions.request ? (
        <form
          className="border-border mt-8 grid max-w-xl gap-4 border-t pt-6"
          autoComplete="off"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await send(
              'create-link',
              `/api/applications/${applicationId}/family-links`,
              'POST',
              {
                relationship: relationship.trim(),
                relativeName: relativeName.trim(),
                ...(community.trim() ? { community: community.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
                relativeDeceased,
              },
              'Family link recorded. A different person can approve or dispute it.',
            );
            if (saved) {
              setRelationship('');
              setRelativeName('');
              setCommunity('');
              setNotes('');
              setRelativeDeceased(false);
            }
          }}
        >
          <h3 className="text-lg font-semibold">Record a family link</h3>
          <div className="grid gap-2">
            <Label htmlFor="family-link-relationship" required>
              Relationship
            </Label>
            <Input
              id="family-link-relationship"
              value={relationship}
              onChange={(event) => setRelationship(event.target.value)}
              maxLength={120}
              required
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="family-link-name" required>
              Relative&apos;s name
            </Label>
            <Input
              id="family-link-name"
              value={relativeName}
              onChange={(event) => setRelativeName(event.target.value)}
              maxLength={200}
              required
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="family-link-community">
              Community, nation, or language group
            </Label>
            <Input
              id="family-link-community"
              value={community}
              onChange={(event) => setCommunity(event.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="family-link-notes">Notes</Label>
            <Textarea
              id="family-link-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={5000}
            />
          </div>
          <div className="flex items-start gap-3">
            <input
              id="family-link-deceased"
              type="checkbox"
              className="border-input focus-visible:ring-ring mt-1 size-4 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              checked={relativeDeceased}
              disabled={!hydrated}
              onChange={(event) => setRelativeDeceased(event.target.checked)}
              aria-describedby="family-link-deceased-hint"
            />
            <div>
              <Label htmlFor="family-link-deceased">Relative is deceased</Label>
              <p
                id="family-link-deceased-hint"
                className="text-muted-foreground mt-1 text-sm"
              >
                Tick this when the relative has passed. Their name stays hidden until
                someone chooses to show it.
              </p>
            </div>
          </div>
          <Button className="w-fit" type="submit" disabled={!hydrated || busy !== null}>
            {busy === 'create-link' ? 'Recording…' : 'Record family link'}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function FamilyLinkItem({
  link,
  applicationId,
  currentUserId,
  deceasedWarning,
  permissions,
  busy,
  hydrated,
  onSend,
}: {
  link: FamilyLinkPanelItem;
  applicationId: string;
  currentUserId: string;
  deceasedWarning: string;
  permissions: FamilyLinksPanelProps['permissions'];
  busy: string | null;
  hydrated: boolean;
  onSend: (
    key: string,
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    success: string,
  ) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const mine = link.requestedByUserId === currentUserId;
  const open = link.status === 'requested';
  const canDecide = open && permissions.approve && !mine;
  const canWithdraw = open && permissions.request && mine;
  const noteId = `family-link-note-${link.id}`;

  async function mutate(
    operation: 'approve' | 'dispute' | 'withdraw',
    success: string,
  ): Promise<void> {
    const saved = await onSend(
      `${operation}:${link.id}`,
      `/api/applications/${applicationId}/family-links/${link.id}`,
      'PATCH',
      operation === 'withdraw'
        ? { operation }
        : { operation, note: note.trim() || undefined },
      success,
    );
    if (saved) setNote('');
  }

  return (
    <li className="py-5 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{link.relationship}</h3>
        <Badge tone={statusTone(link.status)} icon={statusIcon(link.status)}>
          {label(link.status)}
        </Badge>
      </div>
      {link.relativeDeceased ? (
        <p className="text-muted-foreground mt-1 text-sm">Relative is deceased</p>
      ) : null}
      <LinkDetails link={link} warning={deceasedWarning} hydrated={hydrated} />
      {mine && open ? (
        <p className="text-muted-foreground mt-3 text-sm">
          Someone else must approve or dispute this link.
        </p>
      ) : null}
      {canDecide ? (
        <div className="mt-4 grid max-w-xl gap-3">
          <div className="grid gap-2">
            <Label htmlFor={noteId}>Note for this decision</Label>
            <Textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={5000}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!hydrated || busy !== null}
              onClick={() =>
                void mutate('approve', 'Family link approved by a different person.')
              }
            >
              {busy === `approve:${link.id}` ? 'Saving…' : 'Approve link'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!hydrated || busy !== null}
              onClick={() => void mutate('dispute', 'Family link disputed.')}
            >
              {busy === `dispute:${link.id}` ? 'Saving…' : 'Dispute link'}
            </Button>
          </div>
        </div>
      ) : null}
      {canWithdraw ? (
        <Button
          className="mt-4"
          type="button"
          size="sm"
          variant="outline"
          disabled={!hydrated || busy !== null}
          onClick={() => void mutate('withdraw', 'Family link withdrawn.')}
        >
          {busy === `withdraw:${link.id}` ? 'Saving…' : 'Withdraw link'}
        </Button>
      ) : null}
      {link.decisionNote && !link.relativeDeceased ? (
        <p className="mt-3 text-sm whitespace-pre-wrap">
          <span className="text-muted-foreground">Decision note: </span>
          {link.decisionNote}
        </p>
      ) : null}
    </li>
  );
}

function LinkDetails({
  link,
  warning,
  hydrated,
}: {
  link: FamilyLinkPanelItem;
  warning: string;
  hydrated: boolean;
}) {
  const [shown, setShown] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const warningId = `family-link-warning-${link.id}`;

  useEffect(() => {
    if (shown) detailsRef.current?.focus();
  }, [shown]);

  if (!link.relativeDeceased) {
    return (
      <div className="mt-3 space-y-1 text-sm">
        <p>{link.relativeName}</p>
        {link.community ? <p>{link.community}</p> : null}
        {link.notes ? <p className="whitespace-pre-wrap">{link.notes}</p> : null}
      </div>
    );
  }

  if (!shown) {
    return (
      <div className="mt-3 max-w-xl">
        <p id={warningId} className="text-sm">
          {warning}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          aria-describedby={warningId}
          disabled={!hydrated}
          onClick={() => setShown(true)}
        >
          <Eye aria-hidden="true" />
          {`Show recorded name for ${link.relationship}`}
        </Button>
      </div>
    );
  }

  return (
    <div ref={detailsRef} tabIndex={-1} className="mt-3 space-y-1 text-sm outline-none">
      <p>
        <span className="sr-only">Name of a person who has passed: </span>
        {link.relativeName}
      </p>
      {link.community ? <p>{link.community}</p> : null}
      {link.notes ? <p className="whitespace-pre-wrap">{link.notes}</p> : null}
      {link.decisionNote ? (
        <p className="whitespace-pre-wrap">
          <span className="text-muted-foreground">Decision note: </span>
          {link.decisionNote}
        </p>
      ) : null}
    </div>
  );
}
