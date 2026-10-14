/**
 * Process-local list of jobs delayed because of a tenant key. The worker and
 * the key-health loop share a process. A crash drops the list; delayed jobs
 * still wake on their own timer once the key is active again.
 */

const pausedJobs = new Map<string, Set<string>>();

export function rememberPausedJob(organisationId: string, ref: string): void {
  const existing = pausedJobs.get(organisationId) ?? new Set<string>();
  existing.add(ref);
  pausedJobs.set(organisationId, existing);
}

export function takePausedJobs(organisationId: string): string[] {
  const existing = pausedJobs.get(organisationId);
  pausedJobs.delete(organisationId);
  return existing ? [...existing] : [];
}

/** Test hook. */
export function clearPausedJobs(): void {
  pausedJobs.clear();
}
