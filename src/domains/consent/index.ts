/** Consent domain — explicit recorded grants, never inferred. */
export { CONSENT_READ_PERMISSIONS, CONSENT_WRITE_PERMISSIONS } from './permissions';

export {
  hasLiveConsent,
  listConsents,
  recordConsent,
  withdrawConsent,
  type ConsentRow,
} from './service';
