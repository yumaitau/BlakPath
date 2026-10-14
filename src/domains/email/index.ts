/**
 * Email domain — SES permanent-bounce and complaint suppressions.
 * SNS events land in suppressions via POST /api/email/events.
 * A platform operator clears one via POST /api/admin/email-suppressions.
 */
export {
  clearSuppression,
  hashAddress,
  isSuppressed,
  recordSuppression,
} from './service';
