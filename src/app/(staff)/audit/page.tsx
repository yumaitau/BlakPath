import type { Metadata } from 'next';
import { ZodError } from 'zod';
import {
  AuditLogScreen,
  type AuditLogFormValues,
} from '@/components/audit/audit-log-screen';
import { listAuditLog, type AuditLogPage } from '@/domains/audit';
import { UnauthenticatedError } from '@/lib/auth/session';
import { NoActiveOrganisationError, withRequestTenant } from '@/lib/http/tenant-route';
import { AuthorizationError } from '@/lib/permissions/errors';
import { logger } from '@/lib/observability/logger';
import { TenantContextError } from '@/lib/tenancy/context';

export const metadata: Metadata = {
  title: 'Audit trail — BlakPath',
};

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? '';
}

function valuesFrom(search: Search): AuditLogFormValues {
  return {
    caseId: first(search.case),
    userId: first(search.user),
    action: first(search.action),
    from: first(search.from),
    to: first(search.to),
    breakGlass: first(search.breakGlass) === '1',
    denials: first(search.denials) === '1',
  };
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;
  const values = valuesFrom(search);
  const input = {
    case: values.caseId || undefined,
    user: values.userId || undefined,
    action: values.action || undefined,
    from: values.from || undefined,
    to: values.to || undefined,
    breakGlass: values.breakGlass ? '1' : undefined,
    denials: values.denials ? '1' : undefined,
    limit: first(search.limit) || undefined,
    offset: first(search.offset) || undefined,
  };

  let page: AuditLogPage | undefined;
  let denied = false;
  let invalid = false;
  let unavailable = false;
  try {
    page = await withRequestTenant(() => listAuditLog(input));
  } catch (error) {
    if (error instanceof AuthorizationError) {
      denied = true;
    } else if (error instanceof ZodError) {
      invalid = true;
    } else {
      unavailable = true;
      if (
        !(error instanceof UnauthenticatedError) &&
        !(error instanceof NoActiveOrganisationError) &&
        !(error instanceof TenantContextError)
      ) {
        logger.error({ err: error }, 'audit log page failed');
      }
    }
  }

  if (denied) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        You do not have permission to view the audit trail.
      </p>
    );
  }
  if (unavailable) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Sign in and select an organisation to view the audit trail.
      </p>
    );
  }
  return (
    <AuditLogScreen
      values={values}
      {...(page !== undefined ? { page } : {})}
      {...(invalid ? { invalid: true } : {})}
    />
  );
}
