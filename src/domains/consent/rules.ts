/**
 * Consent ledger rules — pure and testable.
 *
 * The ledger is append-only: a grant is one event, a withdrawal is a second
 * event pointing at it. Current state is derived here from that history, never
 * stored and overwritten. Every outcome is a recorded human act; nothing is
 * inferred.
 */

/** Granular purposes a person can consent to. */
export const CONSENT_PURPOSES = [
  'application-processing',
  'evidence-handling',
  'representative-access',
  'inter-organisation-sharing',
  'communications',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * How consent (or its withdrawal) was given:
 *  - signed-form            — a signed paper or electronic form (evidence ref required)
 *  - verbal-witnessed       — spoken, with a named witness
 *  - online-acknowledgement — the person acknowledged it themselves, signed in
 *  - written-request        — a letter or email from the person (evidence ref required)
 */
export const CONSENT_METHODS = [
  'signed-form',
  'verbal-witnessed',
  'online-acknowledgement',
  'written-request',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** Who gave the consent. */
export const CONSENT_GIVERS = ['subject', 'representative', 'guardian'] as const;
export type ConsentGiver = (typeof CONSENT_GIVERS)[number];

/** The channel the act was recorded through. */
export const CONSENT_CHANNELS = ['staff', 'self-service'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_EVENT_KINDS = ['granted', 'withdrawn'] as const;
export type ConsentEventKind = (typeof CONSENT_EVENT_KINDS)[number];

export type ConsentState = 'live' | 'withdrawn' | 'expired';

/**
 * Derive a grant's state from the ledger. A withdrawal always wins; otherwise
 * a grant past its `expiresAt` has lapsed.
 */
export function consentState(
  grant: { expiresAt: Date | null },
  withdrawn: boolean,
  now: Date = new Date(),
): ConsentState {
  if (withdrawn) return 'withdrawn';
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'live';
}

/**
 * The method decides the channel. Online acknowledgement can only be made by
 * the person themselves (or their representative) through self-service; every
 * other method is consent given on paper, verbally or in writing and recorded
 * by staff.
 */
export function channelForMethod(method: ConsentMethod): ConsentChannel {
  return method === 'online-acknowledgement' ? 'self-service' : 'staff';
}

/** Downstream effects run when a grant for this purpose is withdrawn. */
export type WithdrawalEffect = 'revoke-representative-access';

export function withdrawalEffects(purpose: ConsentPurpose): readonly WithdrawalEffect[] {
  return purpose === 'representative-access' ? ['revoke-representative-access'] : [];
}

/** Next wording version number for a purpose (versions start at 1). */
export function nextWordingVersion(latest: number | null | undefined): number {
  return (latest ?? 0) + 1;
}
