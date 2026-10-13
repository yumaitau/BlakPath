import {
  ApplicationRegister,
  type RegisterApplication,
  type RegisterParticipant,
} from '@/components/applications/application-register';
import { listApplicationParticipants, listApplications } from '@/domains/applications';
import { currentCollectionNotice } from '@/domains/consent';
import type { CollectionNotice } from '@/lib/privacy/collection-notice';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ApplicationsPage() {
  let applications: RegisterApplication[] = [];
  let participants: RegisterParticipant[] = [];
  let canCreate = false;
  let collectionNotice: CollectionNotice | null = null;
  let unavailable = false;
  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const mayCreate = ctx.permissions.has('application:create');
      const [listed, linkedApplicants, notice] = await Promise.all([
        listApplications({ limit: 100 }),
        mayCreate ? listApplicationParticipants() : Promise.resolve([]),
        mayCreate ? currentCollectionNotice() : Promise.resolve(null),
      ]);
      return { listed, linkedApplicants, mayCreate, notice };
    });
    participants = loaded.linkedApplicants;
    canCreate = loaded.mayCreate;
    collectionNotice = loaded.notice;
    applications = loaded.listed.items.map((application) => ({
      id: application.id,
      reference: application.reference,
      applicantName: application.applicantName,
      status: application.status,
      priority: application.priority,
      createdAt: application.createdAt.toISOString(),
    }));
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Sign in and select an organisation to view applications.
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ApplicationRegister
        applications={applications}
        participants={participants}
        canCreate={canCreate}
        collectionNotice={collectionNotice}
      />
    </div>
  );
}
