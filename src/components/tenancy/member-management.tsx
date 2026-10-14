'use client';

import { CheckCircle2, Clock3, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface MemberView {
  id: string;
  name: string;
  email: string;
  status: string;
  roleIds: string[];
  roles: string[];
}

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
}

export interface MembershipInvitationView {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  roleId: string;
  roleName: string;
  expiresAt: Date;
  lastSentAt: Date;
}

interface Feedback {
  tone: 'success' | 'destructive' | 'info';
  text: string;
}

const invitationBadge = {
  pending: { tone: 'warning' as const, icon: Clock3, label: 'Pending' },
  accepted: { tone: 'success' as const, icon: CheckCircle2, label: 'Accepted' },
  revoked: { tone: 'destructive' as const, icon: XCircle, label: 'Cancelled' },
  expired: { tone: 'neutral' as const, icon: Clock3, label: 'Expired' },
};

export function MemberManagement({
  members,
  roles,
  invitations,
}: {
  members: MemberView[];
  roles: RoleView[];
  invitations: MembershipInvitationView[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [roleSelections, setRoleSelections] = useState<Record<string, string>>(
    Object.fromEntries(members.map((member) => [member.id, member.roleIds[0] ?? ''])),
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmingRemovalId, setConfirmingRemovalId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [latestInvitationUrl, setLatestInvitationUrl] = useState<string | null>(null);

  const selectedRole = roles.find((role) => role.id === roleId);
  const busy = busyKey !== null;

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyKey('invite');
    setFeedback(null);
    setLatestInvitationUrl(null);
    try {
      const response = await fetch('/api/membership-invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, roleId }),
      });
      if (!response.ok) {
        setFeedback({
          tone: 'destructive',
          text: 'We could not send that invitation. Check whether the person already has access and try again.',
        });
        return;
      }
      const data = (await response.json()) as { url: string };
      setEmail('');
      setLatestInvitationUrl(data.url);
      setFeedback({
        tone: 'success',
        text: 'Invitation created. It is valid only for that email address and this organisation.',
      });
      router.refresh();
    } catch {
      setFeedback({
        tone: 'destructive',
        text: 'We could not reach the service. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function resendInvitation(id: string) {
    setBusyKey(`resend-${id}`);
    setFeedback(null);
    setLatestInvitationUrl(null);
    try {
      const response = await fetch(`/api/membership-invitations/${id}/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        setFeedback({
          tone: 'destructive',
          text: 'That invitation could not be resent. It may no longer be pending.',
        });
        return;
      }
      const data = (await response.json()) as { url: string };
      setLatestInvitationUrl(data.url);
      setFeedback({
        tone: 'success',
        text: 'A new invitation link was created. The previous link no longer works.',
      });
      router.refresh();
    } catch {
      setFeedback({
        tone: 'destructive',
        text: 'We could not reach the service. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function cancelInvitation(id: string) {
    setBusyKey(`cancel-${id}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/membership-invitations/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        setFeedback({
          tone: 'destructive',
          text: 'That invitation could not be cancelled.',
        });
        return;
      }
      setFeedback({ tone: 'success', text: 'Invitation cancelled.' });
      router.refresh();
    } catch {
      setFeedback({
        tone: 'destructive',
        text: 'We could not reach the service. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function setStatus(id: string, status: 'active' | 'suspended' | 'revoked') {
    setBusyKey(`status-${id}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/memberships/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'status', status }),
      });
      if (!response.ok) {
        setFeedback({
          tone: 'destructive',
          text: 'That access change could not be made. You cannot change your own access or remove the last active administrator.',
        });
        return;
      }
      setConfirmingRemovalId(null);
      setFeedback({
        tone: 'success',
        text:
          status === 'revoked'
            ? 'Access removed. The change applies on the person’s next request.'
            : status === 'suspended'
              ? 'Access suspended. The change applies on the person’s next request.'
              : 'Access restored.',
      });
      router.refresh();
    } catch {
      setFeedback({
        tone: 'destructive',
        text: 'We could not reach the service. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function setRole(member: MemberView) {
    const nextRoleId = roleSelections[member.id];
    if (!nextRoleId) return;
    setBusyKey(`role-${member.id}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/memberships/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'role', roleId: nextRoleId }),
      });
      if (!response.ok) {
        setFeedback({
          tone: 'destructive',
          text: 'That role change could not be made. You cannot change your own role or remove the last active administrator.',
        });
        return;
      }
      setFeedback({
        tone: 'success',
        text: 'Role changed. The new permissions apply on the person’s next request.',
      });
      router.refresh();
    } catch {
      setFeedback({
        tone: 'destructive',
        text: 'We could not reach the service. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="text-muted-foreground text-sm font-medium">Organisation settings</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">People and access</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Invite people by email, choose the least-privilege role they need, and remove
          access when their work ends. Every change is recorded in the organisation audit
          trail.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite a staff member</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={invite}
            className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem_auto] sm:items-end"
          >
            <div className="grid gap-2">
              <Label htmlFor="invitation-email">Email address</Label>
              <Input
                id="invitation-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invitation-role">Initial role</Label>
              <select
                id="invitation-role"
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
                className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || !roleId}>
              {busyKey === 'invite' ? 'Sending…' : 'Send invitation'}
            </Button>
          </form>
          {selectedRole?.description ? (
            <p className="text-muted-foreground mt-3 text-sm">
              <span className="text-foreground font-medium">{selectedRole.name}:</span>{' '}
              {selectedRole.description}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {feedback ? (
        <Alert
          tone={feedback.tone}
          role={feedback.tone === 'destructive' ? 'alert' : 'status'}
        >
          {feedback.text}
        </Alert>
      ) : null}

      {latestInvitationUrl ? (
        <div className="grid max-w-2xl gap-2">
          <Label htmlFor="latest-invitation-url">Latest invitation link</Label>
          <Input
            id="latest-invitation-url"
            value={latestInvitationUrl}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-muted-foreground text-sm">
            This link is shown once for manual sharing. Resending creates a new link and
            invalidates the previous one.
          </p>
        </div>
      ) : null}

      <section aria-labelledby="invitations-heading">
        <h2 id="invitations-heading" className="text-lg font-semibold">
          Invitations
        </h2>
        {invitations.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">No invitations yet.</p>
        ) : (
          <ul className="border-border divide-border mt-4 divide-y overflow-hidden rounded-lg border">
            {invitations.map((invitation) => {
              const badge = invitationBadge[invitation.status];
              return (
                <li
                  key={invitation.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-semibold">{invitation.email}</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {invitation.roleName} · sent{' '}
                      {new Date(invitation.lastSentAt).toLocaleDateString('en-AU')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={badge.tone} icon={badge.icon}>
                      {badge.label}
                    </Badge>
                    {invitation.status === 'pending' ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void resendInvitation(invitation.id)}
                        >
                          <RefreshCw aria-hidden="true" />
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void cancelInvitation(invitation.id)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="members-heading">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-primary size-5" aria-hidden="true" />
          <h2 id="members-heading" className="text-lg font-semibold">
            Current access
          </h2>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          Suspending or removing access takes effect on the next request. The last active
          organisation administrator cannot be removed or downgraded.
        </p>
        <ul className="border-border divide-border mt-4 divide-y overflow-hidden rounded-lg border">
          {members.map((member) => (
            <li
              key={member.id}
              className="grid gap-4 px-4 py-4 lg:grid-cols-[1fr_20rem_auto] lg:items-center"
            >
              <div>
                <p className="font-semibold">{member.name}</p>
                <p className="text-muted-foreground text-sm">
                  {member.email} · {member.roles.join(', ') || 'No role assigned'} ·{' '}
                  <span className="capitalize">{member.status}</span>
                </p>
              </div>
              <div className="flex items-end gap-2">
                <div className="grid min-w-0 flex-1 gap-1">
                  <Label htmlFor={`member-role-${member.id}`}>Assigned role</Label>
                  <select
                    id={`member-role-${member.id}`}
                    value={roleSelections[member.id] ?? ''}
                    onChange={(event) =>
                      setRoleSelections((current) => ({
                        ...current,
                        [member.id]: event.target.value,
                      }))
                    }
                    className="border-input bg-surface h-10 min-w-0 rounded-md border px-3 text-sm"
                  >
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || member.status === 'revoked'}
                  onClick={() => void setRole(member)}
                >
                  Change role
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
                {member.status === 'active' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void setStatus(member.id, 'suspended')}
                  >
                    Suspend
                  </Button>
                ) : member.status !== 'revoked' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void setStatus(member.id, 'active')}
                  >
                    Restore
                  </Button>
                ) : null}
                {confirmingRemovalId === member.id ? (
                  <>
                    <span className="text-muted-foreground text-sm">
                      Remove all access?
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void setStatus(member.id, 'revoked')}
                    >
                      Confirm removal
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmingRemovalId(null)}
                    >
                      Keep access
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || member.status === 'revoked'}
                    onClick={() => setConfirmingRemovalId(member.id)}
                  >
                    Remove access
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
