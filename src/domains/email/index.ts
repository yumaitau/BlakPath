/**
 * Email domain — SES bounce/complaint suppressions.
 * Production transport is the SES v2 API (Mailpit SMTP locally); the SES
 * configuration set publishes events via SNS to POST /api/email/events.
 */
export { parseSesEvent, type ParsedSesEvent, type SuppressionTarget } from './events';
export { hashAddress, isSuppressed, recordSuppression } from './service';
