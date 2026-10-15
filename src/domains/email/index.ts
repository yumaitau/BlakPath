/**
 * Email domain — SES permanent-bounce and complaint suppressions.
 * Production transport is the SES v2 API (Mailpit SMTP locally); the SES
 * configuration set publishes events via SNS to POST /api/email/events.
 * A platform operator clears one via POST /api/admin/email-suppressions.
 */
export {
  clearSuppression,
  hashAddress,
  isSuppressed,
  recordSuppression,
} from './service';
