import { CONCURRENCY_CONFLICT_MESSAGE } from '@/lib/concurrency/error';

/**
 * Read a 409 body for display. Returns null for every other status so callers
 * keep their own copy for permission and network failures.
 */
export async function readConflictMessage(response: Response): Promise<string | null> {
  if (response.status !== 409) return null;
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof data?.error === 'string' && data.error.trim().length > 0) {
    return data.error;
  }
  return CONCURRENCY_CONFLICT_MESSAGE;
}
