'use client';

import { TenantKeyUnavailable } from '@/components/encryption/tenant-key-unavailable';
import { ServerErrorView } from '@/components/errors/server-error-view';

/**
 * Staff error boundary. Renders inside the staff shell's `<main>`, so the
 * navigation stays usable and the person can move to another area while the
 * failing one recovers. A tenant key failure renders the locked state instead
 * of a generic server error.
 */
export default function StaffError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const text = `${error.message} ${error.digest ?? ''}`;
  if (text.includes('TENANT_KEY_UNAVAILABLE')) {
    return <TenantKeyUnavailable status="unavailable" />;
  }
  return <ServerErrorView error={error} retry={retry} />;
}
