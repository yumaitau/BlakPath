import type { EVIDENCE_RECEIPT_CHANNELS } from '@/db/schema/enums';
import { hasPermission, type Subject } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

type ReceiptChannel = (typeof EVIDENCE_RECEIPT_CHANNELS)[number];

/**
 * Who may start an evidence upload, after the application read policy has
 * already succeeded.
 *
 * `own` is the applicant (or their representative) uploading to their own
 * case. `on-behalf` is staff recording a file they received for an applicant
 * they can read. `receipt-required` means the actor may record received
 * evidence but has not said how and when it arrived — a validation failure,
 * not a missing permission.
 *
 * Nothing here scores, ranks or infers identity. Receipt is a human record of
 * how a document arrived.
 */
export type EvidenceUploadDecision =
  | { mode: 'own' }
  | { mode: 'on-behalf'; receiptChannel: ReceiptChannel; receivedOn: string }
  | { mode: 'receipt-required' };

export function decideEvidenceUpload(
  subject: Subject,
  isApplicant: boolean,
  receipt: {
    receiptChannel?: string | undefined;
    receivedOn?: string | undefined;
  },
): EvidenceUploadDecision {
  const channel = receipt.receiptChannel;
  const receivedOn = receipt.receivedOn;

  if (channel !== undefined || receivedOn !== undefined) {
    if (!hasPermission(subject, 'evidence:upload-on-behalf')) {
      throw new AuthorizationError('PERMISSION_DENIED');
    }
    if (!isReceiptChannel(channel) || receivedOn === undefined) {
      return { mode: 'receipt-required' };
    }
    return { mode: 'on-behalf', receiptChannel: channel, receivedOn };
  }

  if (hasPermission(subject, 'evidence:upload-own') && isApplicant) {
    return { mode: 'own' };
  }
  if (hasPermission(subject, 'evidence:upload-on-behalf')) {
    return { mode: 'receipt-required' };
  }
  if (hasPermission(subject, 'evidence:upload-own')) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  throw new AuthorizationError('PERMISSION_DENIED');
}

function isReceiptChannel(value: string | undefined): value is ReceiptChannel {
  return (
    value === 'post' || value === 'in_person' || value === 'email' || value === 'other'
  );
}

/**
 * Who may confirm the bytes arrived. Only the user who started the upload may
 * complete it, and only with the permission that matches how it was started.
 * The scan that follows does not look at the receipt.
 */
export function assertCanCompleteEvidenceUpload(
  subject: Subject,
  actorUserId: string,
  row: { uploadedByUserId: string | null; receiptChannel: string | null },
): void {
  if (!row.uploadedByUserId || row.uploadedByUserId !== actorUserId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  if (row.receiptChannel) {
    if (!hasPermission(subject, 'evidence:upload-on-behalf')) {
      throw new AuthorizationError('PERMISSION_DENIED');
    }
    return;
  }
  if (!hasPermission(subject, 'evidence:upload-own')) {
    throw new AuthorizationError('PERMISSION_DENIED');
  }
}
