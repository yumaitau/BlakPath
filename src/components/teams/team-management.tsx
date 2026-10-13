'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type {
  GroupMemberView,
  GroupRow,
  StaffOption,
  TeamMemberView,
  TeamRow,
} from '@/domains/teams';

/** Team + group management. Lists tenant teams/groups and their members. */
export function TeamManagement({
  initialTeams,
  initialGroups,
  teamMembers,
  groupMembers,
  staff,
}: {
  initialTeams: Pick<TeamRow, 'id' | 'slug' | 'name'>[];
  initialGroups: Pick<GroupRow, 'id' | 'slug' | 'name'>[];
  teamMembers: TeamMemberView[];
  groupMembers: GroupMemberView[];
  staff: StaffOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupSlug, setGroupSlug] = useState('');
  const [teamUserId, setTeamUserId] = useState<Record<string, string>>({});
  const [teamRole, setTeamRole] = useState<Record<string, string>>({});
  const [groupUserId, setGroupUserId] = useState<Record<string, string>>({});

  async function send(
    path: string,
    method: 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<boolean> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
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
      const ok = await send('/api/teams', 'POST', {
        name: teamName.trim(),
        slug: teamSlug.trim(),
      });
      if (ok) {
        setMessage('Team created.');
        setTeamName('');
        setTeamSlug('');
        router.refresh();
      }
    });
  }

  function onCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const ok = await send('/api/groups', 'POST', {
        name: groupName.trim(),
        slug: groupSlug.trim(),
      });
      if (ok) {
        setMessage('Group created.');
        setGroupName('');
        setGroupSlug('');
        router.refresh();
      }
    });
  }

  function onAddTeamMember(e: React.FormEvent, teamId: string) {
    e.preventDefault();
    const userId = teamUserId[teamId];
    if (!userId) {
      setMessage('Choose a staff member.');
      return;
    }
    startTransition(async () => {
      const role = teamRole[teamId] === 'lead' ? 'lead' : 'member';
      const ok = await send(`/api/teams/${teamId}/members`, 'POST', { userId, role });
      if (ok) {
        setMessage('Team member added.');
        router.refresh();
      }
    });
  }

  function onRemoveTeamMember(teamId: string, userId: string) {
    startTransition(async () => {
      const ok = await send(`/api/teams/${teamId}/members/${userId}`, 'DELETE');
      if (ok) {
        setMessage('Team member removed.');
        router.refresh();
      }
    });
  }

  function onAddGroupMember(e: React.FormEvent, groupId: string) {
    e.preventDefault();
    const userId = groupUserId[groupId];
    if (!userId) {
      setMessage('Choose a staff member.');
      return;
    }
    startTransition(async () => {
      const ok = await send(`/api/groups/${groupId}/members`, 'POST', { userId });
      if (ok) {
        setMessage('Group member added.');
        router.refresh();
      }
    });
  }

  function onRemoveGroupMember(groupId: string, userId: string) {
    startTransition(async () => {
      const ok = await send(`/api/groups/${groupId}/members/${userId}`, 'DELETE');
      if (ok) {
        setMessage('Group member removed.');
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Teams and groups</h1>
        <p className="text-muted-foreground text-sm">
          Teams organise staff inside your council. Groups scope finer access. Membership
          lets a case officer read matters whose client sits with that team. It does not
          decide anyone&apos;s identity.
        </p>
      </div>

      <section aria-label="Teams">
        <h2 className="text-lg font-semibold">Teams</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {initialTeams.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">No teams yet.</li>
          ) : null}
          {initialTeams.map((team) => {
            const members = teamMembers.filter((member) => member.teamId === team.id);
            return (
              <li key={team.id} className="flex flex-col gap-3 p-3 text-sm">
                <div>
                  <span className="font-medium">{team.name}</span>{' '}
                  <span className="text-muted-foreground">({team.slug})</span>
                </div>
                <ul
                  aria-label={`Members of ${team.name}`}
                  className="flex flex-col gap-2"
                >
                  {members.length === 0 ? (
                    <li className="text-muted-foreground">No members yet.</li>
                  ) : null}
                  {members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span>
                        {member.name}{' '}
                        <span className="text-muted-foreground">
                          ({member.email}) · {member.role}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onRemoveTeamMember(team.id, member.userId)}
                      >
                        Remove {member.name} from {team.name}
                      </Button>
                    </li>
                  ))}
                </ul>
                <form
                  onSubmit={(event) => onAddTeamMember(event, team.id)}
                  className="flex flex-wrap items-end gap-2"
                  aria-label={`Add member to ${team.name}`}
                >
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`team-member-${team.id}`}
                      className="text-xs font-medium"
                    >
                      Staff member
                    </label>
                    <select
                      id={`team-member-${team.id}`}
                      className="rounded border px-2 py-1 text-sm"
                      value={teamUserId[team.id] ?? ''}
                      onChange={(event) =>
                        setTeamUserId((current) => ({
                          ...current,
                          [team.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose staff</option>
                      {staff.map((person) => (
                        <option key={person.userId} value={person.userId}>
                          {person.name} ({person.email})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`team-role-${team.id}`}
                      className="text-xs font-medium"
                    >
                      Team role
                    </label>
                    <select
                      id={`team-role-${team.id}`}
                      className="rounded border px-2 py-1 text-sm"
                      value={teamRole[team.id] ?? 'member'}
                      onChange={(event) =>
                        setTeamRole((current) => ({
                          ...current,
                          [team.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="member">Member</option>
                      <option value="lead">Lead</option>
                    </select>
                  </div>
                  <Button type="submit" size="sm" disabled={pending}>
                    Add to {team.name}
                  </Button>
                </form>
              </li>
            );
          })}
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
          {initialGroups.map((group) => {
            const members = groupMembers.filter((member) => member.groupId === group.id);
            return (
              <li key={group.id} className="flex flex-col gap-3 p-3 text-sm">
                <div>
                  <span className="font-medium">{group.name}</span>{' '}
                  <span className="text-muted-foreground">({group.slug})</span>
                </div>
                <ul
                  aria-label={`Members of ${group.name}`}
                  className="flex flex-col gap-2"
                >
                  {members.length === 0 ? (
                    <li className="text-muted-foreground">No members yet.</li>
                  ) : null}
                  {members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span>
                        {member.name}{' '}
                        <span className="text-muted-foreground">({member.email})</span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onRemoveGroupMember(group.id, member.userId)}
                      >
                        Remove {member.name} from {group.name}
                      </Button>
                    </li>
                  ))}
                </ul>
                <form
                  onSubmit={(event) => onAddGroupMember(event, group.id)}
                  className="flex flex-wrap items-end gap-2"
                  aria-label={`Add member to ${group.name}`}
                >
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`group-member-${group.id}`}
                      className="text-xs font-medium"
                    >
                      Staff member
                    </label>
                    <select
                      id={`group-member-${group.id}`}
                      className="rounded border px-2 py-1 text-sm"
                      value={groupUserId[group.id] ?? ''}
                      onChange={(event) =>
                        setGroupUserId((current) => ({
                          ...current,
                          [group.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose staff</option>
                      {staff.map((person) => (
                        <option key={person.userId} value={person.userId}>
                          {person.name} ({person.email})
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" size="sm" disabled={pending}>
                    Add to {group.name}
                  </Button>
                </form>
              </li>
            );
          })}
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
