'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Columns3,
  FolderOpen,
  LayoutDashboard,
  Settings,
  UserCog,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { cn } from '@/lib/utils';

export interface StaffOrganisation {
  organisationId: string;
  organisationName: string;
  slug: string;
}

const navigation = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/applications', label: 'Applications', icon: FolderOpen },
  { href: '/clients', label: 'Clients', icon: Users },
  { href: '/board', label: 'Board', icon: Columns3 },
  { href: '/meetings', label: 'Meetings', icon: CalendarDays },
  { href: '/forms', label: 'Forms', icon: ClipboardList },
  { href: '/settings/teams', label: 'Teams', icon: UserCog },
  { href: '/settings/security', label: 'Settings', icon: Settings },
] as const;

function isCurrentPath(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
}

/** Authenticated staff chrome: navigational context, tenant switcher and inbox. */
export function StaffShell({
  organisations,
  activeOrganisationId,
}: {
  organisations: readonly StaffOrganisation[];
  activeOrganisationId: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const current = organisations.find(
    (org) => org.organisationId === activeOrganisationId,
  );

  async function switchOrganisation(organisationId: string) {
    if (organisationId === activeOrganisationId || switching) return;
    setSwitching(true);
    try {
      const response = await fetch('/api/organisations/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organisationId }),
      });
      if (!response.ok) return;
      router.push('/dashboard');
      router.refresh();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <header className="border-border bg-surface border-b">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex min-h-16 items-center justify-between gap-3">
          <Link
            href="/dashboard"
            className="shrink-0 text-lg font-semibold tracking-tight focus-visible:outline-none"
          >
            <span className="text-primary">Blak</span>Path
          </Link>

          <nav
            aria-label="Primary navigation"
            className="hidden flex-1 justify-center gap-1 md:flex"
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              const currentPath = isCurrentPath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={currentPath ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none',
                    currentPath
                      ? 'bg-surface-muted text-foreground'
                      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="hover:bg-surface-muted focus-visible:ring-ring flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:px-3"
                  aria-label={`Switch organisation. Current organisation: ${current?.organisationName ?? 'Unknown'}`}
                >
                  <Building2
                    className="text-muted-foreground size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground hidden text-xs font-medium lg:inline">
                    Organisation
                  </span>
                  <span className="max-w-36 truncate text-sm font-semibold sm:max-w-56">
                    {switching ? 'Switching…' : current?.organisationName}
                  </span>
                  <ChevronDown
                    className="text-muted-foreground size-4 shrink-0"
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={8}
                  className="border-border bg-surface z-50 w-72 rounded-lg border p-1 shadow-lg"
                >
                  <DropdownMenu.Label className="text-muted-foreground px-2 py-1.5 text-xs font-semibold">
                    Switch organisation
                  </DropdownMenu.Label>
                  <DropdownMenu.RadioGroup value={activeOrganisationId}>
                    {organisations.map((organisation) => (
                      <DropdownMenu.RadioItem
                        key={organisation.organisationId}
                        value={organisation.organisationId}
                        disabled={switching}
                        onSelect={(event) => {
                          event.preventDefault();
                          void switchOrganisation(organisation.organisationId);
                        }}
                        className="data-[highlighted]:bg-surface-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55"
                      >
                        <DropdownMenu.ItemIndicator className="text-primary grid size-4 place-items-center">
                          <span aria-hidden="true">✓</span>
                        </DropdownMenu.ItemIndicator>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {organisation.organisationName}
                        </span>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <NotificationBell />
            <SignOutButton variant="ghost" size="sm" className="hidden sm:inline-flex" />
          </div>
        </div>

        <nav
          aria-label="Primary navigation"
          className="-mx-1 flex gap-1 overflow-x-auto pb-2 md:hidden"
        >
          {navigation.map((item) => {
            const Icon = item.icon;
            const currentPath = isCurrentPath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={currentPath ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none',
                  currentPath
                    ? 'bg-surface-muted text-foreground'
                    : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
          <SignOutButton
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0 sm:hidden"
          />
        </nav>
      </div>
    </header>
  );
}
