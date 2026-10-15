import Link from 'next/link';
import { formatAnswerValue, type FormField } from '@/lib/forms/fields';

/**
 * Form responses that belong to one case.
 *
 * These are answers a person submitted. They are shown so staff do not re-type
 * them. Nothing here scores, ranks or decides Aboriginality.
 */

export interface CaseFormResponseView {
  id: string;
  formId: string;
  formTitle: string;
  fields: FormField[];
  respondentName: string | null;
  respondentEmail: string | null;
  submittedAt: string;
  answers: Record<string, unknown>;
}

function entries(
  fields: FormField[],
  answers: Record<string, unknown>,
): Array<{ key: string; label: string; value: string }> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return Object.entries(answers).map(([key, value]) => {
    const field = byKey.get(key);
    return {
      key,
      label: field?.label ?? key,
      value: formatAnswerValue(value, field?.type),
    };
  });
}

export function CaseFormResponses({ responses }: { responses: CaseFormResponseView[] }) {
  if (responses.length === 0) return null;

  return (
    <section aria-label="Form responses" className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight">Form responses</h2>
      <p className="text-muted-foreground text-sm">
        Answers a person submitted on a form. BlakPath does not score or decide
        Aboriginality from them.
      </p>
      <ul className="flex flex-col gap-3">
        {responses.map((response) => (
          <li
            key={response.id}
            className="border-border bg-surface flex flex-col gap-2 rounded-md border p-4"
          >
            <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
              <Link href={`/forms/${response.formId}`} className="text-primary underline">
                {response.formTitle}
              </Link>
              <span>·</span>
              <span>
                {response.respondentName ?? response.respondentEmail ?? 'Anonymous'}
              </span>
              <span>·</span>
              <span>{new Date(response.submittedAt).toLocaleString()}</span>
            </div>
            <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
              {entries(response.fields, response.answers).map((entry) => (
                <div key={entry.key} className="contents">
                  <dt className="text-muted-foreground font-medium">{entry.label}</dt>
                  <dd className="text-foreground">{entry.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
