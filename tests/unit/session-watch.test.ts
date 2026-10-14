// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn(async () => ({}));
vi.mock('@/lib/auth/client', () => ({ signOut: () => signOut() }));

const { SessionWatch } = await import('@/components/auth/session-watch');
const { LAST_ACTIVITY_STORAGE_KEY } = await import('@/lib/auth/idle');

const MINUTE = 60_000;
const assign = vi.fn();
const realLocation = window.location;
const realFetch = globalThis.fetch;

describe('SessionWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    signOut.mockClear();
    assign.mockClear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        origin: 'http://localhost',
        pathname: '/board',
        search: '?view=mine',
        assign,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: realLocation,
    });
    globalThis.fetch = realFetch;
  });

  it('warns two minutes before the idle sign-out and lets the person stay', async () => {
    render(createElement(SessionWatch, { idleTimeoutMinutes: 5 }));
    expect(screen.queryByText('Are you still there?')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(3 * MINUTE + 1000);
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Are you still there?')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Are you still there?')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out after the timeout and returns to sign-in with the current page', async () => {
    render(createElement(SessionWatch, { idleTimeoutMinutes: 5 }));
    await act(async () => {
      vi.advanceTimersByTime(5 * MINUTE + 1000);
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      '/sign-in?returnTo=%2Fboard%3Fview%3Dmine&reason=idle',
    );
  });

  it('counts activity recorded by another tab', async () => {
    render(createElement(SessionWatch, { idleTimeoutMinutes: 5 }));
    await act(async () => {
      vi.advanceTimersByTime(4 * MINUTE);
    });
    expect(screen.getByText('Are you still there?')).toBeTruthy();

    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Are you still there?')).toBeNull();
  });

  it('sends an expired session (API 401) to sign-in with the current page', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"Unauthorized"}', { status: 401 }),
    ) as unknown as typeof fetch;
    render(createElement(SessionWatch, { idleTimeoutMinutes: 30 }));

    await act(async () => {
      await window.fetch('/api/tasks');
    });
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(
      '/sign-in?returnTo=%2Fboard%3Fview%3Dmine&reason=expired',
    );
  });
});
