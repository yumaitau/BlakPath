'use client';

import { TenantKeyUnavailable } from '@/components/encryption/tenant-key-unavailable';
import { Button } from '@/components/ui/button';

/**
 * Staff error boundary. A tenant key failure renders the locked state instead
 * of a generic server error. Other failures stay calm and offer a retry.
 */
export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const text = `${error.message} ${error.digest ?? ''}`;
  if (text.includes('TENANT_KEY_UNAVAILABLE')) {
    return <TenantKeyUnavailable status="unavailable" />;
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-xl font-semibold">This page could not be loaded</h1>
      <p className="text-muted-foreground mt-3 text-sm">Nothing was changed.</p>
      <Button type="button" variant="secondary" className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
