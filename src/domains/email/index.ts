/**
 * Email domain — SES permanent-bounce and complaint suppressions.
 * Production transport is the SES v2 API (Mailpit SMTP locally); the SES
 * configuration set publishes events via SNS to POST /api/email/events.
 * A platform operator clears one via POST /api/admin/email-suppressions; an
 * organisation administrator clears one for their own member or invitee from
 * Settings → People.
 */
export {
  clearSuppression,
  clearSuppressionForTarget,
  hashAddress,
  isSuppressed,
  recordSuppression,
  suppressionsFor,
  type SuppressionKind,
} from './service';
