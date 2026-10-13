/** Consent domain — append-only ledger of explicit recorded acts, never inferred. */
export {
  hasLiveConsent,
  isLiveGrant,
  listConsents,
  listMyConsents,
  listWordingVersions,
  publishWordingVersion,
  recordConsent,
  withdrawConsent,
  type ConsentEventRow,
  type ConsentView,
  type ConsentWordingRow,
  type WithdrawalResult,
} from './service';
export * from './rules';
export * from './schemas';
