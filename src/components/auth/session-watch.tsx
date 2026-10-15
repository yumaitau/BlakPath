'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth/client';
import { installSessionExpiryGuard } from '@/lib/auth/fetch-guard';
import {
  formatCountdown,
  idleStatus,
  LAST_ACTIVITY_STORAGE_KEY,
  parseStoredActivity,
  type IdlePhase,
} from '@/lib/auth/idle';
import { signInPath, type SignInReason } from '@/lib/auth/return-to';

/**
 * Session watch for the staff shell (renders nothing until needed).
 *
 * 1. Expired session: a 401 from any of our API calls sends the person to
 *    sign-in with `returnTo` set to the page they were on (see
 *    `installSessionExpiryGuard`).
 * 2. Inactivity: after `idleTimeoutMinutes` without activity the session is
 *    signed out (server-side revocation via Better Auth). A warning dialog
 *    appears two minutes beforehand. Activity in any open tab counts — the last
 *    activity time is shared through localStorage.
 *
 * Inactivity sign-out is a convenience control on shared devices; it is not
 * the session's security boundary (server-side expiry still applies).
 */

const TICK_MS = 1000;
// Activity is recorded at most this often, to keep localStorage writes cheap.
const ACTIVITY_WRITE_THROTTLE_MS = 5000;
const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
] as const;

function readSharedActivity(now: number): number | null {
  try {
    return parseStoredActivity(
      window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY),
      now,
    );
  } catch {
    return null;
  }
}

function writeSharedActivity(at: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Storage blocked (private mode, policy): fall back to this tab's timer.
  }
}

export function SessionWatch({ idleTimeoutMinutes }: { idleTimeoutMinutes: number }) {
  const timeoutMs = idleTimeoutMinutes * 60 * 1000;
  const [phase, setPhase] = useState<IdlePhase>('active');
  const [remainingMs, setRemainingMs] = useState(timeoutMs);

  const lastActivityRef = useRef(0);
  const lastWriteRef = useRef(0);
  const phaseRef = useRef<IdlePhase>('active');
  const leavingRef = useRef(false);

  const leave = useCallback(async (reason: SignInReason) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    if (reason === 'idle') {
      // Revoke the session server-side; navigate even if that call fails.
      await signOut().catch(() => undefined);
    }
    window.location.assign(signInPath(returnTo, reason));
  }, []);

  const recordActivity = useCallback((force = false) => {
    const now = Date.now();
    lastActivityRef.current = now;
    if (force || now - lastWriteRef.current >= ACTIVITY_WRITE_THROTTLE_MS) {
      lastWriteRef.current = now;
      writeSharedActivity(now);
    }
  }, []);

  // Expired session → sign-in, returning here afterwards.
  useEffect(
    () =>
      installSessionExpiryGuard(window, window.location.origin, () => {
        void leave('expired');
      }),
    [leave],
  );

  // Inactivity tracking.
  useEffect(() => {
    recordActivity(true);

    const onActivity = () => {
      // While the warning is open only an explicit choice keeps the session.
      if (phaseRef.current === 'active') recordActivity();
    };

    const tick = () => {
      const now = Date.now();
      const shared = readSharedActivity(now);
      if (shared !== null && shared > lastActivityRef.current) {
        lastActivityRef.current = shared;
      }
      const status = idleStatus(now, lastActivityRef.current, timeoutMs);
      phaseRef.current = status.phase;
      setPhase(status.phase);
      setRemainingMs(status.remainingMs);
      if (status.phase === 'expired') void leave('idle');
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true, capture: true });
    }
    // Timers are throttled in background tabs; re-check as soon as it returns.
    document.addEventListener('visibilitychange', tick);
    const interval = window.setInterval(tick, TICK_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', tick);
      window.clearInterval(interval);
    };
  }, [leave, recordActivity, timeoutMs]);

  const signOutNow = async () => {
    leavingRef.current = true;
    await signOut().catch(() => undefined);
    window.location.assign(signInPath());
  };

  const staySignedIn = () => {
    recordActivity(true);
    phaseRef.current = 'active';
    setPhase('active');
  };

  return (
    <Dialog.Root
      open={phase === 'warning'}
      onOpenChange={(open) => {
        // Escape or clicking outside also counts as "stay signed in".
        if (!open) staySignedIn();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bg-charcoal/50 fixed inset-0 z-50" />
        <Dialog.Content
          role="alertdialog"
          className="border-border bg-surface fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border p-6 shadow-lg focus:outline-none"
        >
          <Dialog.Title className="text-lg font-semibold tracking-tight">
            Are you still there?
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground mt-2 text-sm">
            For your security, you will be signed out after a period of inactivity.
            Signing out in{' '}
            <span className="text-foreground font-semibold tabular-nums">
              {formatCountdown(remainingMs)}
            </span>
            .
          </Dialog.Description>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => void signOutNow()}>
              Sign out now
            </Button>
            <Button type="button" onClick={staySignedIn} autoFocus>
              Stay signed in
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
