import { getPublicCorrespondence } from '@/domains/correspondence';
import { publicKeyDegradation } from '@/lib/encryption/public-degradation';

/**
 * Applicant letter page.
 *
 * The token is the only capability. The page shows the letter stored on the
 * case. It does not decide anything about the person.
 */
export default async function PublicCorrespondencePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await getPublicCorrespondence(token).then(
    (value) => ({ letter: value, unavailable: null }),
    // A locked tenant key must not look like a bad link.
    (error: unknown) => ({ letter: null, unavailable: publicKeyDegradation(error) }),
  );
  const { letter, unavailable } = loaded;

  if (unavailable) {
    return (
      <article className="border-border bg-surface rounded-xl border p-6">
        <h1 className="text-xl font-semibold">This letter can&apos;t be shown</h1>
        <p className="text-muted-foreground mt-2 text-sm">{unavailable}</p>
      </article>
    );
  }

  if (!letter) {
    return (
      <article className="border-border bg-surface rounded-xl border p-6">
        <h1 className="text-xl font-semibold">This link is not valid</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          It may have expired, or it may have been typed incorrectly. Contact the
          organisation that wrote to you if you still need the letter.
        </p>
      </article>
    );
  }

  const expires = new Date(letter.expiresAt).toLocaleDateString('en-AU', {
    dateStyle: 'long',
    timeZone: 'Australia/Sydney',
  });

  return (
    <article className="border-border bg-surface rounded-xl border p-6">
      <p className="text-muted-foreground text-sm">{letter.organisationName}</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{letter.subject}</h1>
      <pre className="mt-6 text-sm whitespace-pre-wrap">{letter.body}</pre>
      {letter.kind === 'certificate' && letter.certificateAvailable ? (
        <p className="mt-6">
          <a
            className="text-primary font-semibold underline-offset-4 hover:underline"
            href={`/api/public/correspondence/${token}/certificate`}
          >
            Download certificate
          </a>
        </p>
      ) : null}
      {letter.kind === 'certificate' && !letter.certificateAvailable ? (
        <p className="text-muted-foreground mt-6 text-sm">
          The certificate is no longer available from this link.
        </p>
      ) : null}
      <p className="text-muted-foreground mt-8 text-sm">
        This link expires on {expires}. This letter records what people in the
        organisation decided to send. BlakPath does not determine Aboriginality.
      </p>
    </article>
  );
}
