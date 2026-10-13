/**
 * Thrown when a submission does not acknowledge the organisation's CURRENT
 * collection notice (missing, forged or stale version/hash). Kept dependency
 * free so the HTTP error mapper can import it without loading the database.
 */
export class CollectionNoticeError extends Error {
  readonly code = 'COLLECTION_NOTICE_NOT_ACKNOWLEDGED';
  readonly status = 409;
  constructor() {
    super('Please read and acknowledge the current collection notice.');
    this.name = 'CollectionNoticeError';
  }
}
