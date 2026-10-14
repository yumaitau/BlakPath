'use client';

import { useSyncExternalStore } from 'react';

function subscribe(): () => void {
  return () => undefined;
}

/**
 * False in the server render and during hydration, true once React has
 * hydrated (and immediately on client-side navigations).
 *
 * Action buttons render `disabled={!hydrated || busy}` so a click that lands
 * before the handler is attached is refused visibly instead of being lost, or
 * of falling back to a native form submission.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
