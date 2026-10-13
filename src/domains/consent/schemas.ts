import { z } from 'zod';
import { CONSENT_GIVERS, CONSENT_METHODS, CONSENT_PURPOSES } from './rules';

/**
 * Input validation for the consent ledger (zod v4).
 *
 * Method and evidence rules are enforced here so every recorded act carries
 * its proof: a signed form or written request needs an evidence reference,
 * verbal consent needs a witness, and consent given by someone other than the
 * subject names that person and their relationship.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

/** Fields shared by grants and withdrawals: how, with what proof, by whom. */
const actFields = {
  method: z.enum(CONSENT_METHODS),
  evidenceReference: text(500).optional(),
  witnessName: text(200).optional(),
  givenBy: z.enum(CONSENT_GIVERS).default('subject'),
  representativeName: text(200).optional(),
  representativeRelationship: text(120).optional(),
  representativeUserId: z.uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
};

interface ActShape {
  method: (typeof CONSENT_METHODS)[number];
  evidenceReference?: string | undefined;
  witnessName?: string | undefined;
  givenBy: (typeof CONSENT_GIVERS)[number];
  representativeName?: string | undefined;
  representativeRelationship?: string | undefined;
}

function checkAct(value: ActShape, ctx: z.RefinementCtx): void {
  if (
    (value.method === 'signed-form' || value.method === 'written-request') &&
    !value.evidenceReference
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceReference'],
      message: 'A signed form or written request needs an evidence reference.',
    });
  }
  if (value.method === 'verbal-witnessed' && !value.witnessName) {
    ctx.addIssue({
      code: 'custom',
      path: ['witnessName'],
      message: 'Verbal consent needs a named witness.',
    });
  }
  if (
    value.givenBy !== 'subject' &&
    (!value.representativeName || !value.representativeRelationship)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['representativeName'],
      message: 'Name the representative or guardian and their relationship.',
    });
  }
}

/** Publish a new, immutable wording version for a purpose. */
export const publishWordingSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  title: text(200),
  body: text(20_000),
  locale: text(35).default('en-AU'),
});
export type PublishWordingInput = z.input<typeof publishWordingSchema>;

/** Record a consent grant against a user account and/or a client record. */
export const recordConsentSchema = z
  .object({
    subjectUserId: z.uuid().optional(),
    subjectClientId: z.uuid().optional(),
    purpose: z.enum(CONSENT_PURPOSES),
    wordingVersionId: z.uuid(),
    sharingRecipient: text(300).optional(),
    expiresAt: z.coerce.date().optional(),
    ...actFields,
  })
  .superRefine((value, ctx) => {
    if (!value.subjectUserId && !value.subjectClientId) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectClientId'],
        message: 'Identify the person by account or client record.',
      });
    }
    if (value.purpose === 'inter-organisation-sharing' && !value.sharingRecipient) {
      ctx.addIssue({
        code: 'custom',
        path: ['sharingRecipient'],
        message: 'Name the organisation information may be shared with.',
      });
    }
    if (value.expiresAt && value.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Expiry must be in the future.',
      });
    }
    checkAct(value, ctx);
  });
export type RecordConsentInput = z.input<typeof recordConsentSchema>;

/** Withdraw a grant — the withdrawal is its own recorded act. */
export const withdrawConsentSchema = z
  .object(actFields)
  .superRefine((value, ctx) => checkAct(value, ctx));
export type WithdrawConsentInput = z.input<typeof withdrawConsentSchema>;

/** Identify whose consents to list: an account, a client record, or both. */
export const consentSubjectSchema = z
  .object({
    subjectUserId: z.uuid().optional(),
    subjectClientId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.subjectUserId ?? v.subjectClientId), {
    message: 'Identify the person by account or client record.',
  });
export type ConsentSubjectInput = z.input<typeof consentSubjectSchema>;
