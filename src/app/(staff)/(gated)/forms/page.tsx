import Link from 'next/link';
import { NewFormButton } from '@/components/forms/new-form-button';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listForms, type FormRow } from '@/domains/forms';

/**
 * Forms list (RSC).
 *
 * Loads the tenant's forms inside a DB-verified tenant context and lists them
 * with a link to each editor and a "New form" control. If the caller is not
 * signed in or has no active organisation, a friendly prompt is shown instead
 * of an error.
 *
 * PRODUCT INVARIANT: forms only collect information a human provides. They never
 * determine a person's Aboriginality.
 */

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  closed: 'Closed',
};

export default async function FormsPage() {
  let forms: FormRow[] = [];
  let error: string | null = null;

  try {
    forms = await withRequestTenant(() => listForms());
  } catch {
    error = 'Sign in and select your organisation to view and manage forms.';
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Forms</h1>
        {error || forms.length === 0 ? null : <NewFormButton />}
      </div>

      {error ? (
        <p className="text-muted-foreground">{error}</p>
      ) : forms.length === 0 ? (
        <section className="border-border bg-surface max-w-xl rounded-lg border p-5">
          <h2 className="text-lg font-semibold">Create your first form</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Forms help you collect the information you need from people, in a clear and
            consistent way.
          </p>
          <div className="mt-4">
            <NewFormButton />
          </div>
        </section>
      ) : (
        <ul className="flex flex-col gap-2">
          {forms.map((form) => (
            <li key={form.id}>
              <Link
                href={`/forms/${form.id}`}
                className="border-border bg-surface hover:bg-surface-muted focus-visible:ring-ring focus-visible:ring-offset-background flex items-center justify-between gap-3 rounded-md border p-4 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground text-sm font-medium">
                    {form.title}
                  </span>
                  {form.description ? (
                    <span className="text-muted-foreground line-clamp-1 text-xs">
                      {form.description}
                    </span>
                  ) : null}
                </div>
                <span className="text-muted-foreground text-xs">
                  {STATUS_LABELS[form.status] ?? form.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
