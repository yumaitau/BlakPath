import { redirect } from 'next/navigation';
import {
  ApplicationRegister,
  type RegisterApplication,
  type RegisterAssignee,
  type RegisterExportRequest,
  type RegisterParticipant,
} from '@/components/applications/application-register';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { APPLICATION_STATUSES } from '@/domains/applications/workflow';
import {
  listApplicationParticipants,
  listApplications,
  listRegisterAssignees,
} from '@/domains/applications';
import { listApplicationsSchema } from '@/domains/applications/schemas';
import { listExports, readStoredExportFilters } from '@/domains/reporting';
import {
  isTenantKeyUnavailable,
  TENANT_KEY_UNAVAILABLE_MESSAGE,
} from '@/lib/encryption/errors';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = {
    q: first(params.q),
    status: first(params.status),
    assignee: first(params.assignee),
    cursor: first(params.cursor),
  };
  const parsed = listApplicationsSchema.safeParse({
    limit: 25,
    q: raw.q || undefined,
    status: raw.status || undefined,
    assigneeUserId: raw.assignee || undefined,
    cursor: raw.cursor || undefined,
  });
  if (!parsed.success) redirect('/applications');

  let applications: RegisterApplication[] = [];
  let participants: RegisterParticipant[] = [];
  let assignees: RegisterAssignee[] = [];
  let exports: RegisterExportRequest[] = [];
  let canCreate = false;
  let canExport = false;
  let currentUserId = '';
  let nextCursor: string | null = null;
  let forbidden = false;
  let locked = false;

  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const mayCreate = ctx.permissions.has('application:create');
      const mayExport = ctx.permissions.has('report:export');
      const mayListAssignees = ctx.permissions.has('application:read-any');
      const [listed, linkedApplicants, assigneeRows, exportRows] = await Promise.all([
        listApplications(parsed.data),
        mayCreate ? listApplicationParticipants() : Promise.resolve([]),
        mayListAssignees ? listRegisterAssignees() : Promise.resolve([]),
        mayExport ? listExports() : Promise.resolve([]),
      ]);
      return {
        listed,
        linkedApplicants,
        assigneeRows,
        exportRows,
        mayCreate,
        mayExport,
        userId: ctx.userId,
      };
    });
    participants = loaded.linkedApplicants;
    assignees = loaded.assigneeRows;
    canCreate = loaded.mayCreate;
    canExport = loaded.mayExport;
    currentUserId = loaded.userId;
    nextCursor = loaded.listed.nextCursor;
    applications = loaded.listed.items.map((application) => ({
      id: application.id,
      reference: application.reference,
      applicantName: application.applicantName,
      status: application.status,
      priority: application.priority,
      createdAt: application.createdAt.toISOString(),
    }));
    exports = loaded.exportRows
      .filter((row) => row.type === 'applications')
      .slice(0, 6)
      .map((row) => {
        let filters: {
          status?: string | undefined;
          from?: string | undefined;
          to?: string | undefined;
        } = {};
        try {
          filters = readStoredExportFilters(row.params);
        } catch {
          filters = {};
        }
        return {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          rowCount: row.rowCount,
          from: filters.from ?? null,
          to: filters.to ?? null,
          applicationStatus: filters.status ?? null,
        };
      });
  } catch (error) {
    if (isTenantKeyUnavailable(error)) {
      locked = true;
    } else {
      await handlePageError(error);
      forbidden = true;
    }
  }

  if (locked) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {TENANT_KEY_UNAVAILABLE_MESSAGE}
      </p>
    );
  }

  if (forbidden) {
    return (
      <ForbiddenNotice title="You do not have access to applications">
        <p>
          Your role in this organisation does not include the application register. If you
          need access, ask an organisation administrator.
        </p>
      </ForbiddenNotice>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ApplicationRegister
        applications={applications}
        participants={participants}
        assignees={assignees}
        exports={exports}
        statuses={APPLICATION_STATUSES}
        filters={{
          q: parsed.data.q ?? '',
          status: parsed.data.status ?? '',
          assignee: parsed.data.assigneeUserId ?? '',
          cursor: parsed.data.cursor ?? '',
        }}
        nextCursor={nextCursor}
        currentUserId={currentUserId}
        canCreate={canCreate}
        canExport={canExport}
      />
    </div>
  );
}
