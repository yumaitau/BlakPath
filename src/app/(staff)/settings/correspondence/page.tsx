import Link from 'next/link';
import {
  TemplateEditor,
  type TemplateEditorItem,
} from '@/components/correspondence/template-editor';
import { listTemplates } from '@/domains/correspondence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { hasPermission, subjectFromContext } from '@/lib/permissions/check';

/**
 * Organisation correspondence templates.
 *
 * Templates are wording only. Saving one does not send a letter.
 */
async function loadTemplates(): Promise<{
  denied: boolean;
  templates: TemplateEditorItem[];
}> {
  try {
    return await withRequestTenant(async (ctx) => {
      if (!hasPermission(subjectFromContext(ctx), 'correspondence:manage-templates')) {
        return { denied: true, templates: [] };
      }
      const rows = await listTemplates();
      return {
        denied: false,
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
  } catch {
    return { denied: true, templates: [] };
  }
}

export default async function CorrespondenceTemplatesPage() {
  const { denied, templates } = await loadTemplates();

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
      {denied ? (
        <p className="text-muted-foreground mt-6">
          Your role cannot edit letter templates.
        </p>
      ) : (
        <div className="mt-8">
          <TemplateEditor templates={templates} />
        </div>
      )}
    </div>
  );
}
