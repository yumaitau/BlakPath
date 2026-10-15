import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CertificateTemplateForm,
  type TemplateFormInitial,
} from '@/components/certificates/template-form';
import { getCertificateTemplate } from '@/domains/certificates';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const metadata: Metadata = {
  title: 'Certificate template — BlakPath',
};

/**
 * Organisation-authored certificate layout. Publishing a change stores a new
 * version and an audit event. Only `tenant:configure` may open this page.
 */
export default async function CertificateTemplatePage() {
  let initial: TemplateFormInitial | null = null;
  let denied = false;
  try {
    const template = await withRequestTenant(() => getCertificateTemplate());
    initial = template
      ? {
          version: template.version,
          wording: template.wording,
          signatoryName: template.signatoryName,
          signatoryRole: template.signatoryRole,
          hasLogo: template.hasLogo,
        }
      : null;
  } catch (error) {
    // Session and organisation failures redirect; outages reach error.tsx.
    await handlePageError(error);
    denied = true;
  }

  if (denied) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        Only organisation administrators can edit the certificate template.
      </p>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <p className="text-muted-foreground text-sm">
        <Link
          href="/settings/security"
          className="font-semibold underline-offset-4 hover:underline"
        >
          Settings
        </Link>
      </p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Certificate template</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Wording, logo and signatory are printed on each draft so staff can preview them
        before anyone signs. Publishing stores a new version. Certificates already signed
        keep the version they were issued with.
        {initial ? ` Current version: ${initial.version}.` : ' Nothing is published yet.'}
      </p>
      <CertificateTemplateForm key={initial?.version ?? 0} initial={initial} />
    </div>
  );
}
