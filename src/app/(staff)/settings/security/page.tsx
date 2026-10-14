import type { Metadata } from 'next';
import Link from 'next/link';

import { SecuritySettings } from '@/components/auth/security-settings';
import { Button } from '@/components/ui/button';

/**
 * Account security settings (RSC wrapper).
 *
 * This is a thin server component: all of the security controls are inherently
 * interactive (they call the browser auth client, read reactive session state
 * and handle sensitive one-time secrets), so the work lives in the client
 * component. The wrapper only sets the page heading and metadata.
 */
export const metadata: Metadata = {
  title: 'Account security — BlakPath',
};

export default function SecuritySettingsPage() {
  return (
    <section aria-labelledby="security-heading" className="mt-6 max-w-2xl">
      <h1 id="security-heading" className="text-2xl font-semibold tracking-tight">
        Account security
      </h1>
      <p className="text-muted-foreground mt-2">
        Add extra protection to your account with two-step verification and passkeys.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/people">Manage people and access</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/encryption-keys">Encryption keys</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/audit" prefetch={false}>
            Audit trail
          </Link>
        </Button>
      </div>
      <div className="mt-8">
        <SecuritySettings />
      </div>
    </section>
  );
}
