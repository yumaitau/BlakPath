import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import type { OrganisationKeyStatus } from '@/domains/organisation-keys';
import { TENANT_KEY_UNAVAILABLE_MESSAGE } from '@/lib/encryption/errors';

export type LockedKeyStatus = Exclude<OrganisationKeyStatus, 'active'>;

/**
 * Calm locked state for staff. The sentence is the same for a disabled key,
 * a key pending deletion and a key KMS will not use: contact the key
 * administrator. Records stay unread. There is no plaintext fallback.
 */
export function TenantKeyUnavailable({ status }: { status: LockedKeyStatus }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <Alert tone="warning" role="status" title="Records are locked">
        <p>{TENANT_KEY_UNAVAILABLE_MESSAGE}</p>
        <p className="mt-2">
          Nothing was shown. Other organisations are unaffected.
          <span className="sr-only"> Key status: {status}.</span>
        </p>
        <p className="mt-2">
          Organisation administrators can see the key&apos;s status and check it on{' '}
          <Link
            href="/settings/encryption-keys"
            className="text-primary underline underline-offset-4"
          >
            Encryption keys
          </Link>
          .
        </p>
      </Alert>
    </div>
  );
}
