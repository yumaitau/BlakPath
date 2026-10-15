'use client';

import { AlertTriangle, Check, Clock, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { withStepUp } from '@/lib/auth/step-up-flow';
import { useHydrated } from '@/lib/hooks/use-hydrated';

export interface BreakGlassListItem {
  id: string;
  status: string;
  supportCaseRef: string;
  purpose: string;
  scope: string;
  expiresAt: string | null;
  activatedAt: string | null;
  reviewDueAt: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  requestedByUserId: string;
}

const STATUS_TONE = {
  requested: 'info',
  approved: 'success',
  denied: 'destructive',
  active: 'warning',
  expired: 'neutral',
  revoked: 'destructive',
} as const;

function statusIcon(status: string) {
  if (status === 'approved') return Check;
  if (status === 'denied' || status === 'revoked') return X;
  if (status === 'active') return ShieldAlert;
  return Clock;
}

function formatWhen(value: string | null): string {
  if (!value) return 'Not set';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function reviewOverdue(item: BreakGlassListItem): boolean {
  if (item.reviewedAt || !item.reviewDueAt) return false;
  if (
    item.status !== 'active' &&
    item.status !== 'expired' &&
    item.status !== 'revoked'
  ) {
    return false;
  }
  return new Date(item.reviewDueAt).getTime() < Date.now();
}

async function postJson(
  url: string,
  reauthenticate: () => Promise<boolean>,
  body?: unknown,
): Promise<string | null> {
  // Every mutation is JSON so the cookie-mutation guard accepts it.
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
  const response = await withStepUp(() => fetch(url, init), reauthenticate);
  if (response.ok) return null;
  if (response.status === 401) return 'Sign in again to confirm this action.';
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? 'That action could not be completed.';
}

/** Tenant approval queue: approve, deny, revoke, and record the post-use review. */
export function TenantBreakGlass({
  initialItems,
}: {
  initialItems: BreakGlassListItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const hydrated = useHydrated();
  const stepUp = useStepUp();
  const reauthenticate = () => stepUp.request();

  async function reload() {
    const response = await fetch('/api/break-glass');
    if (!response.ok) {
      setError('The break-glass list could not be refreshed.');
      return;
    }
    const payload = (await response.json()) as { items: BreakGlassListItem[] };
    setItems(payload.items);
  }

  async function run(id: string, task: () => Promise<string | null>) {
    setBusyId(id);
    setError(null);
    try {
      const message = await task();
      if (message) {
        setError(message);
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4">
      {error ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No emergency access requests.</p>
      ) : null}
      {items.map((item) => {
        const overdue = reviewOverdue(item);
        const tone = STATUS_TONE[item.status as keyof typeof STATUS_TONE] ?? 'neutral';
        const canDecide = item.status === 'requested';
        const canRevoke = item.status === 'approved' || item.status === 'active';
        const canReview =
          !item.reviewedAt &&
          item.activatedAt !== null &&
          (item.status === 'active' ||
            item.status === 'expired' ||
            item.status === 'revoked');
        return (
          <Card key={item.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <span>Support case {item.supportCaseRef}</span>
                <Badge tone={tone} icon={statusIcon(item.status)}>
                  {item.status}
                </Badge>
                {overdue ? (
                  <Badge tone="destructive" icon={AlertTriangle}>
                    Review overdue
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Purpose</dt>
                  <dd>{item.purpose}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd>{item.scope}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd>{formatWhen(item.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Review due</dt>
                  <dd>{formatWhen(item.reviewDueAt)}</dd>
                </div>
              </dl>

              {canDecide ? (
                <div className="grid gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={!hydrated || busyId === item.id}
                      onClick={() =>
                        void run(item.id, () =>
                          postJson(`/api/break-glass/${item.id}/approve`, reauthenticate),
                        )
                      }
                    >
                      Approve
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`deny-${item.id}`}>Reason for denial</Label>
                    <Textarea
                      id={`deny-${item.id}`}
                      value={denyReason[item.id] ?? ''}
                      onChange={(event) =>
                        setDenyReason((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={
                        !hydrated ||
                        busyId === item.id ||
                        !(denyReason[item.id] ?? '').trim()
                      }
                      onClick={() =>
                        void run(item.id, () =>
                          postJson(`/api/break-glass/${item.id}/deny`, reauthenticate, {
                            reason: denyReason[item.id] ?? '',
                          }),
                        )
                      }
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              ) : null}

              {canRevoke ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!hydrated || busyId === item.id}
                  onClick={() =>
                    void run(item.id, () =>
                      postJson(`/api/break-glass/${item.id}/revoke`, reauthenticate),
                    )
                  }
                >
                  Revoke access
                </Button>
              ) : null}

              {canReview ? (
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(item.id, () =>
                      postJson(`/api/break-glass/${item.id}/review`, reauthenticate, {
                        notes: reviewNotes[item.id] ?? '',
                      }),
                    );
                  }}
                >
                  <Label htmlFor={`review-${item.id}`}>Review notes</Label>
                  <Textarea
                    id={`review-${item.id}`}
                    required
                    value={reviewNotes[item.id] ?? ''}
                    onChange={(event) =>
                      setReviewNotes((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                  />
                  <p className="text-muted-foreground text-sm">
                    Record whether this access matched the support case. Due within 5
                    business days of activation (Australia/Sydney weekdays).
                  </p>
                  <Button type="submit" disabled={!hydrated || busyId === item.id}>
                    Record review
                  </Button>
                </form>
              ) : null}

              {item.reviewedAt ? (
                <div className="text-sm">
                  <p className="text-muted-foreground">
                    Reviewed {formatWhen(item.reviewedAt)}
                  </p>
                  {item.reviewNotes ? <p className="mt-1">{item.reviewNotes}</p> : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
      <StepUpDialog open={stepUp.open} onFinish={stepUp.finish} />
    </div>
  );
}
