import Link from 'next/link';
import {
  TemplateEditor,
  type TemplateEditorItem,
} from '@/components/correspondence/template-editor';
import { listTemplates } from '@/domains/correspondence';
import {
  isTenantKeyUnavailable,
  TENANT_KEY_UNAVAILABLE_MESSAGE,
} from '@/lib/encryption/errors';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { hasPermission, subjectFromContext } from '@/lib/permissions/check';

/**
 * Organisation correspondence templates.
 *
 * Templates are wording only. Saving one does not send a letter.
 */
type Loaded =
  | { state: 'ok'; templates: TemplateEditorItem[] }
  | { state: 'denied' }
  | { state: 'locked' };

/**
 * A locked tenant key is not a permission problem: it gets main's key-locked
 * message. Session and organisation failures redirect; outages reach error.tsx.
 */
async function loadTemplates(): Promise<Loaded> {
  try {
    return await withRequestTenant(async (ctx) => {
      if (!hasPermission(subjectFromContext(ctx), 'correspondence:manage-templates')) {
        return { state: 'denied' } as const;
      }
      const rows = await listTemplates();
      return {
        state: 'ok' as const,
        templates: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          subjectTemplate: row.subjectTemplate,
          bodyTemplate: row.bodyTemplate,
          active: row.active,
        })),
      };
    });
  } catch (error) {
    if (isTenantKeyUnavailable(error)) return { state: 'locked' };
    await handlePageError(error);
    return { state: 'denied' };
  }
}

export default async function CorrespondenceTemplatesPage() {
  const loaded = await loadTemplates();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/settings/security"
        className="text-muted-foreground text-sm font-semibold underline-offset-4 hover:underline"
      >
        Settings
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Letter templates</h1>
      <p className="text-muted-foreground mt-2">
        Each organisation writes its own letters. Staff still preview and send each one.
      </p>
      {loaded.state === 'locked' ? (
        <p className="text-muted-foreground mt-6" role="status">
          {TENANT_KEY_UNAVAILABLE_MESSAGE}
        </p>
      ) : loaded.state === 'denied' ? (
        <p className="text-muted-foreground mt-6">
          Your role cannot edit letter templates.
        </p>
      ) : (
        <div className="mt-8">
          <TemplateEditor templates={loaded.templates} />
        </div>
      )}
    </div>
  );
}
