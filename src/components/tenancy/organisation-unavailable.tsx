import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { Button } from '@/components/ui/button';

/**
 * Generic refusal shown when the signed-in user's organisation is suspended
 * or closed. The copy does not name which status applies.
 */
export function OrganisationUnavailable({ canSwitch = false }: { canSwitch?: boolean }) {
  return (
    <div className="bg-surface-muted flex min-h-dvh items-center justify-center px-4 py-12">
      <main
        id="main-content"
        tabIndex={-1}
        className="border-border bg-surface w-full max-w-xl rounded-xl border p-6 shadow-md sm:p-8"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          Organisation unavailable
        </h1>
        <p className="text-muted-foreground mt-2">
          This organisation is unavailable. You cannot work in it right now.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {canSwitch ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/select-organisation">Choose another organisation</Link>
            </Button>
          ) : null}
          <SignOutButton variant={canSwitch ? 'ghost' : 'secondary'} size="sm" />
        </div>
      </main>
    </div>
  );
}
