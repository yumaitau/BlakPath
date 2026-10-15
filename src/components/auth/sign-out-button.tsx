'use client';

import { useState } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { signOut } from '@/lib/auth/client';

/**
 * Sign-out button. Ends the session, then navigates to the sign-in page.
 *
 * We use a hard navigation (`window.location`) rather than the router so any
 * cached session state is fully discarded — signing out should never leave a
 * stale, partially-authenticated view behind.
 */
export function SignOutButton({
  children = 'Sign out',
  variant = 'ghost',
  ...props
}: Omit<ButtonProps, 'onClick' | 'asChild'>) {
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    try {
      await signOut();
    } finally {
      // Navigate regardless: if sign-out failed, the sign-in page will
      // re-establish the correct state rather than trapping the user here.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- drop cached client session state; see file comment
      window.location.href = '/sign-in';
    }
  }

  return (
    <Button variant={variant} onClick={handleSignOut} disabled={pending} {...props}>
      {pending ? 'Signing out…' : children}
    </Button>
  );
}
