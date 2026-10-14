import { DelayedError } from 'bullmq';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';

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
  | 'pending_validation'
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

/**
 * A job whose tenant key went non-active after the gate passed (the processor
 * threw {@link TenantKeyUnavailableError}) is delayed the same way. Returns
 * true when the caller must throw {@link tenantKeyPauseSignal}; any other error
 * is left to the normal retry policy.
 */
export async function pauseOnTenantKeyLoss(input: {
  err: unknown;
  now?: number;
  moveToDelayed: (timestamp: number) => Promise<void>;
}): Promise<boolean> {
  if (!(input.err instanceof TenantKeyUnavailableError)) return false;
  await applyTenantJobGate({
    status: 'unavailable',
    ...(input.now === undefined ? {} : { now: input.now }),
    moveToDelayed: input.moveToDelayed,
  });
  return true;
}

/** BullMQ treats this name as a delay, not a failed attempt. */
export function tenantKeyPauseSignal(): DelayedError {
  return new DelayedError();
}
