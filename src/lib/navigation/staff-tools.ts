import { CONSENT_READ_PERMISSIONS } from '@/domains/consent/permissions';
import { REPRESENTATIVE_LIST_PERMISSIONS } from '@/domains/representatives/permissions';
import type { Permission } from '@/lib/permissions/catalog';

/**
 * Staff screens for work that used to be API-only.
 *
 * A link is shown only when the person holds at least one of `anyOf`. The
 * same lists gate the pages, so a hidden tool cannot be opened by guessing
 * the address.
 */

export interface StaffToolLink {
  href: string;
  label: string;
  anyOf: readonly Permission[];
}

export const STAFF_TOOL_LINKS = [
  {
    href: '/reports',
    label: 'Reports',
    anyOf: ['report:view', 'report:export'],
  },
  {
    href: '/imports',
    label: 'Imports',
    anyOf: ['application:create'],
  },
  {
    href: '/consents',
    label: 'Consents',
    anyOf: CONSENT_READ_PERMISSIONS,
  },
  {
    href: '/representatives',
    label: 'Representatives',
    anyOf: REPRESENTATIVE_LIST_PERMISSIONS,
  },
  {
    href: '/settings/api-keys',
    label: 'API keys',
    anyOf: ['tenant:configure'],
  },
  {
    href: '/settings/webhooks',
    label: 'Webhooks',
    anyOf: ['tenant:configure'],
  },
  {
    href: '/settings/sso',
    label: 'Single sign-on',
    anyOf: ['tenant:configure'],
  },
  {
    href: '/settings/retention',
    label: 'Retention',
    anyOf: ['retention:manage'],
  },
  {
    href: '/audit',
    label: 'Audit trail',
    anyOf: ['audit:view'],
  },
  {
    href: '/settings/break-glass',
    label: 'Break-glass',
    anyOf: ['break-glass:approve'],
  },
] as const satisfies readonly StaffToolLink[];

export function visibleStaffTools(
  permissions: ReadonlySet<string>,
): readonly StaffToolLink[] {
  return STAFF_TOOL_LINKS.filter((link) =>
    link.anyOf.some((key) => permissions.has(key)),
  );
}

export function canOpenStaffTool(
  permissions: ReadonlySet<string>,
  href: string,
): boolean {
  const link = STAFF_TOOL_LINKS.find((item) => item.href === href);
  if (!link) return false;
  return link.anyOf.some((key) => permissions.has(key));
}
