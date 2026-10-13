'use client';

import { ServerErrorView } from '@/components/errors/server-error-view';

/**
 * Staff error boundary. Renders inside the staff shell's `<main>`, so the
 * navigation stays usable and the person can move to another area while the
 * failing one recovers.
 */
export default function StaffError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ServerErrorView error={error} retry={retry} />;
}
