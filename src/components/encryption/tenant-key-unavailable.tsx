import { Alert } from '@/components/ui/alert';

export type LockedKeyStatus = 'disabled' | 'pending_deletion' | 'unavailable';

const detail: Record<LockedKeyStatus, string> = {
  disabled: 'The encryption key for this organisation is turned off.',
  pending_deletion: 'The encryption key for this organisation is pending deletion.',
  unavailable: 'The encryption key for this organisation cannot be reached.',
};

/**
 * Calm locked state. Records stay unread. There is no plaintext fallback and
 * no retry that would show data under another key.
 */
export function TenantKeyUnavailable({ status }: { status: LockedKeyStatus }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <Alert tone="warning" role="status" title="Records are locked">
        <p>{detail[status]}</p>
        <p className="mt-2">
          BlakPath did not open this organisation&apos;s records, and it will not show
          them under a different key. A key custodian can restore access. Other
          organisations are unaffected.
        </p>
      </Alert>
    </div>
  );
}
