import { DelayedError } from 'bullmq';

/**
 * A tenant key that is not active must not burn BullMQ attempts. The worker
 * moves the job to delayed and throws {@link DelayedError}, which BullMQ does
 * not count as a failure. An organisation with no key row is not paused: that
 * is the pre-enrolment state, not a revocation.
 */
export const TENANT_KEY_PAUSE_MS = 30_000;

export type TenantJobKeyStatus =
  | 'active'
  | 'disabled'
  | 'pending_deletion'
  | 'unavailable'
  | null;

export function tenantJobAction(status: TenantJobKeyStatus): 'run' | 'pause' {
  if (status === null || status === 'active') return 'run';
  return 'pause';
}

export async function applyTenantJobGate(input: {
  status: TenantJobKeyStatus;
  now?: number;
  moveToDelayed: (timestamp: number) => Promise<void>;
}): Promise<'run' | 'paused'> {
  if (tenantJobAction(input.status) === 'run') return 'run';
  await input.moveToDelayed((input.now ?? Date.now()) + TENANT_KEY_PAUSE_MS);
  return 'paused';
}

/** BullMQ treats this name as a delay, not a failed attempt. */
export function tenantKeyPauseSignal(): DelayedError {
  return new DelayedError();
}
