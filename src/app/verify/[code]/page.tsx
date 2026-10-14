import { headers } from 'next/headers';
import { HolderCheckForm } from '@/components/certificates/holder-check-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { verifyCertificate } from '@/domains/certificates';
import { publicKeyDegradation } from '@/lib/encryption/public-degradation';
import { clientIp } from '@/lib/http/client-ip';

/**
 * Public certificate verification (RSC, unauthenticated).
 *
 * The verification code in the URL is the capability. The page returns only
 * non-personal confirmation: validity, reference, issuing organisation, sign
 * date and whether the seal checks out. It never shows the holder's name.
 * When the seal includes a holder hash, the verifier can type the name printed
 * on the document and learn only whether it matches. Request limits for this
 * page run in `src/proxy.ts`.
 */
export const dynamic = 'force-dynamic';

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const headerList = await headers();
  const ipAddress = clientIp({ headers: headerList });
  const userAgent = headerList.get('user-agent');

  let lookup: Awaited<ReturnType<typeof verifyCertificate>> | null = null;
  let keyMessage: string | null = null;
  try {
    lookup = await verifyCertificate(code, { ipAddress, userAgent });
  } catch (error) {
    keyMessage = publicKeyDegradation(error);
    lookup = null;
  }

  if (keyMessage) {
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6"
        tabIndex={-1}
      >
        <Card>
          <CardHeader>
            <CardTitle>Verification is unavailable</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">{keyMessage}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const result = lookup?.status === 'ok' ? lookup.verification : null;
  const title =
    lookup?.status === 'rate_limited'
      ? 'Too many checks'
      : lookup === null
        ? 'Verification unavailable'
        : result?.valid
          ? 'Valid certificate'
          : result?.status === 'superseded'
            ? 'This certificate has been superseded'
            : result
              ? 'This certificate is not valid'
              : 'Certificate not found';

  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6"
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          {lookup?.status === 'rate_limited' ? (
            <p className="text-muted-foreground text-sm">
              Too many verification attempts from this network. Wait a few minutes and try
              again.
            </p>
          ) : lookup === null ? (
            <p className="text-muted-foreground text-sm">
              We could not complete this check. Try again shortly.
            </p>
          ) : result ? (
            <>
              {result.status === 'superseded' ? (
                <p className="text-muted-foreground mb-4 text-sm">
                  This certificate was replaced and is no longer valid. The replacement is
                  not identified here.
                </p>
              ) : null}
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
              {result.holderBound && result.signatureValid && result.payloadIntact ? (
                <>
                  <p className="mt-4 text-sm">
                    The seal does not, by itself, confirm the name printed on a document.
                  </p>
                  <HolderCheckForm code={code} />
                </>
              ) : !result.holderBound &&
                (result.status === 'signed' || result.status === 'revoked') ? (
                <p className="text-muted-foreground mt-4 text-sm">
                  This seal covers the reference, organisation and date. It does not
                  include the holder’s name, so a matching code does not confirm the name
                  printed on a document.
                </p>
              ) : null}
            </>
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
