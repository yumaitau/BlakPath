import type { Metadata } from 'next';

import { SecuritySettings } from '@/components/auth/security-settings';

export const metadata: Metadata = {
  title: 'Enrol a second factor — BlakPath',
};

/**
 * MFA enrolment outside the staff shell.
 *
 * Production staff routes redirect here until a passkey or authenticator
 * exists. The page stays outside that shell so enrolment is reachable.
 */
export default function EnrolSecondFactorPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Enrol a second factor</h1>
      <p className="text-muted-foreground mt-2">
        Organisation tools stay closed until this account has a passkey or an
        authenticator app.
      </p>
      <div className="mt-8">
        <SecuritySettings />
      </div>
    </main>
  );
}
