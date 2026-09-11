/**
 * Email domain — SES bounce/complaint suppressions.
 * Transport stays SMTP (SES SMTP interface in prod, Mailpit local);
 * SNS events land in suppressions via POST /api/email/events.
 */
export { hashAddress, isSuppressed, recordSuppression } from './service';
