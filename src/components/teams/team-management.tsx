'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { GroupRow, TeamRow } from '@/domains/teams';

/** Team + group management. Lists tenant teams/groups, creates either. */
export function TeamManagement({
  initialTeams,
  initialGroups,
}: {
  initialTeams: Pick<TeamRow, 'id' | 'slug' | 'name'>[];
  initialGroups: Pick<GroupRow, 'id' | 'slug' | 'name'>[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupSlug, setGroupSlug] = useState('');

  async function post(path: string, body: unknown): Promise<boolean> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 403) {
      setMessage('No permission for that action.');
      return false;
    }
    if (!res.ok) {
      setMessage('Could not save. Check fields and try again.');
      return false;
    }
    return true;
  }

  function onCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const ok = await post('/api/teams', {
        name: teamName.trim(),
        slug: teamSlug.trim(),
      });
      if (ok) {
        setMessage('Team created. Refresh to see it.');
        setTeamName('');
        setTeamSlug('');
      }
    });
  }

  function onCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const ok = await post('/api/groups', {
        name: groupName.trim(),
        slug: groupSlug.trim(),
      });
      if (ok) {
        setMessage('Group created. Refresh to see it.');
        setGroupName('');
        setGroupSlug('');
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Teams and groups</h1>
        <p className="text-muted-foreground text-sm">
          Teams organise staff inside your council. Groups scope finer access.
        </p>
      </div>

      <section aria-label="Teams">
        <h2 className="text-lg font-semibold">Teams</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {initialTeams.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">No teams yet.</li>
          ) : null}
          {initialTeams.map((t) => (
            <li key={t.id} className="p-3 text-sm">
              <span className="font-medium">{t.name}</span>{' '}
              <span className="text-muted-foreground">({t.slug})</span>
            </li>
          ))}
        </ul>
        <form
          onSubmit={onCreateTeam}
          className="mt-3 flex flex-wrap items-end gap-2"
          aria-label="Create team"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="team-name" className="text-xs font-medium">
              Team name
            </label>
            <input
              id="team-name"
              className="rounded border px-2 py-1 text-sm"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="Intake"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="team-slug" className="text-xs font-medium">
              Slug
            </label>
            <input
              id="team-slug"
              className="rounded border px-2 py-1 text-sm"
              value={teamSlug}
              onChange={(e) => setTeamSlug(e.target.value)}
              placeholder="intake"
            />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            Create team
          </Button>
        </form>
      </section>

      <section aria-label="Groups">
        <h2 className="text-lg font-semibold">Groups</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {initialGroups.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">No groups yet.</li>
          ) : null}
          {initialGroups.map((g) => (
            <li key={g.id} className="p-3 text-sm">
              <span className="font-medium">{g.name}</span>{' '}
              <span className="text-muted-foreground">({g.slug})</span>
            </li>
          ))}
        </ul>
        <form
          onSubmit={onCreateGroup}
          className="mt-3 flex flex-wrap items-end gap-2"
          aria-label="Create group"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="group-name" className="text-xs font-medium">
              Group name
            </label>
            <input
              id="group-name"
              className="rounded border px-2 py-1 text-sm"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Duty desk"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="group-slug" className="text-xs font-medium">
              Slug
            </label>
            <input
              id="group-slug"
              className="rounded border px-2 py-1 text-sm"
              value={groupSlug}
              onChange={(e) => setGroupSlug(e.target.value)}
              placeholder="duty-desk"
            />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            Create group
          </Button>
        </form>
      </section>

      {message ? (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
