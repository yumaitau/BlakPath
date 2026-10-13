/** Consent domain — explicit recorded grants, never inferred. */
export {
  hasLiveConsent,
  listConsents,
  recordConsent,
  withdrawConsent,
  type ConsentRow,
} from './service';

export {
  CollectionNoticeError,
  assertNoticeAcknowledged,
  currentCollectionNotice,
  loadCollectionNotice,
  recordNoticeAcknowledgement,
  type CollectionNoticeAcknowledgementRow,
  type RecordAcknowledgementInput,
} from './notices';
