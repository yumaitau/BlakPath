import Link from 'next/link';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { FormBuilder } from '@/components/forms/form-builder';
import {
  FormInvitations,
  type InvitationListItem,
} from '@/components/forms/form-invitations';
import { FormStatusControls } from '@/components/forms/form-status-controls';
import { handlePageError, isRecordId } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { parseFieldsJson } from '@/lib/forms/fields';
import {
  getForm,
  listInvitations,
  listResponses,
  type PublicFormInvitation,
  type FormResponseRow,
  type FormRow,
} from '@/domains/forms';

/**
 * Form editor (RSC).
 *
 * Loads a form together with its invitations and responses inside a DB-verified
 * tenant context, then renders the builder, the publish/close controls, the
 * invitation manager, and a plain table of submitted responses. An expired
 * session redirects to sign-in; a missing or forbidden form shows the same
 * non-committal 403 state; anything else surfaces as the 500 error page.
 *
 * PRODUCT INVARIANT: a form collects information a human provides. It never
 * scores, ranks or determines a person's Aboriginality — responses shown here
 * are simply the answers a recipient gave.
 */

interface LoadedForm {
  form: FormRow;
  invitations: PublicFormInvitation[];
  responses: FormResponseRow[];
}

/** Render one response's answers as readable key: value lines. */
function answerEntries(answers: unknown): Array<[string, string]> {
  if (answers === null || typeof answers !== 'object') return [];
  return Object.entries(answers as Record<string, unknown>).map(([key, value]) => {
    let display: string;
    if (value === null || value === undefined) display = '—';
    else if (Array.isArray(value)) display = value.map((v) => String(v)).join(', ');
    else display = String(value);
    return [key, display];
  });
}

function toInvitationListItem(row: PublicFormInvitation): InvitationListItem {
  return {
    id: row.id,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export default async function FormEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: LoadedForm | null = null;
  if (isRecordId(id)) {
    try {
      data = await withRequestTenant(async () => ({
        form: await getForm(id),
        invitations: await listInvitations(id),
        responses: await listResponses(id),
      }));
    } catch (error) {
      await handlePageError(error);
    }
  }

  if (!data) {
    return (
      <ForbiddenNotice
        title="Form unavailable"
        backHref="/forms"
        backLabel="Back to forms"
      >
        <p>
          This form does not exist, is outside your organisation, or your role does not
          allow you to manage it.
        </p>
      </ForbiddenNotice>
    );
  }

  const { form, invitations, responses } = data;
  const fields = parseFieldsJson(form.fields);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href="/forms" className="text-muted-foreground text-xs underline">
            Back to forms
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{form.title}</h1>
        </div>
        <FormStatusControls formId={form.id} status={form.status} />
      </div>

      <div className="flex flex-col gap-10">
        <section aria-label="Form builder">
          <FormBuilder
            formId={form.id}
            initialTitle={form.title}
            initialDescription={form.description}
            initialFields={fields}
          />
        </section>

        <section aria-label="Invitations" className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Invitations</h2>
          <FormInvitations
            formId={form.id}
            initialInvitations={invitations.map(toInvitationListItem)}
          />
        </section>

        <section aria-label="Responses" className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Responses ({responses.length})
          </h2>
          {responses.length === 0 ? (
            <p className="text-muted-foreground text-sm">No responses yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {responses.map((response) => (
                <li
                  key={response.id}
                  className="border-border bg-surface flex flex-col gap-2 rounded-md border p-4"
                >
                  <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                    <span>
                      {response.respondentName ?? response.respondentEmail ?? 'Anonymous'}
                    </span>
                    <span>·</span>
                    <span>{response.submittedAt.toLocaleString()}</span>
                  </div>
                  <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                    {answerEntries(response.answers).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground font-medium">{key}</dt>
                        <dd className="text-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
