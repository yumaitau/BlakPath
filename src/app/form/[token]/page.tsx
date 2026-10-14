import { getPublicForm } from '@/domains/forms';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PublicFormRenderer } from '@/components/forms/public-form-renderer';

/**
 * Public, tokenised form completion page (RSC).
 *
 * The token in the URL is the only capability: `getPublicForm` looks it up by
 * hash and either returns the recipient-facing form (marking the invitation
 * opened) or throws for any invalid/expired/used/revoked token. There is no
 * session here, so we call the service directly — never via `withRequestTenant`.
 * Request limits for this page run in `src/proxy.ts` (a real 429 before render).
 *
 * PRODUCT INVARIANT: a form collects information a human provides. It never
 * scores, ranks or determines a person's Aboriginality.
 */

// Token-specific and side-effecting (marks the invitation opened); never cached.
export const dynamic = 'force-dynamic';

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Resolve the form OUTSIDE the JSX return. Any failure is a bad token; we
  // never distinguish "expired" from "revoked" from "never existed" — the
  // message stays deliberately uniform.
  let form: Awaited<ReturnType<typeof getPublicForm>> | null = null;
  try {
    form = await getPublicForm(token);
  } catch {
    form = null;
  }

  if (!form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>This link is no longer valid</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            This form link is invalid or has expired. If you were expecting to fill in a
            form, please ask the person who sent it to share a new link.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <PublicFormRenderer token={token} form={form} />;
}
