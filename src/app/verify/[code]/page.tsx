import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { verifyCertificate } from '@/domains/certificates';

/**
 * Public certificate verification (RSC, unauthenticated).
 *
 * The verification code in the URL is the capability. We return only
 * non-personal confirmation of authenticity — whether a certificate with that
 * code exists and is currently valid, its reference, the issuing organisation,
 * the sign date, and whether its cryptographic seal checks out. No applicant
 * detail is exposed.
 */
export const dynamic = 'force-dynamic';

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  let result: Awaited<ReturnType<typeof verifyCertificate>> = null;
  try {
    result = await verifyCertificate(code);
  } catch {
    result = null;
  }

  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6"
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            {result?.valid
              ? 'Valid certificate'
              : result
                ? 'This certificate is not valid'
                : 'Certificate not found'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {result ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="font-medium">{result.reference}</dd>
              <dt className="text-muted-foreground">Organisation</dt>
              <dd className="font-medium">{result.organisationName}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium">{result.status}</dd>
              {result.signedOn ? (
                <>
                  <dt className="text-muted-foreground">Signed on</dt>
                  <dd className="font-medium">{result.signedOn}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Digital seal</dt>
              <dd className="font-medium">
                {result.signatureValid && result.payloadIntact
                  ? 'Verified — sealed by the issuing organisation'
                  : 'Not verified — treat with caution'}
              </dd>
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">
              We couldn’t find a certificate for this code. Check the code and try again,
              or contact the issuing organisation.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
