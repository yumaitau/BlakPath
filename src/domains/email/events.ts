import { z } from 'zod';

/**
 * Pure parsing of SES bounce/complaint events delivered through SNS.
 *
 * Two SES shapes reach POST /api/email/events:
 *   - configuration-set event publishing (the production path): `eventType`;
 *   - identity feedback notifications (legacy): `notificationType`.
 *
 * Only permanent bounces and complaints suppress an address. Transient and
 * undetermined bounces (mailbox full, greylisting) must not lock someone out
 * of invite-only onboarding, so they are acknowledged and ignored.
 */

const sesMessage = z.object({
  eventType: z.string().optional(),
  notificationType: z.string().optional(),
  mail: z.object({ messageId: z.string().optional() }).optional(),
  bounce: z
    .object({
      bounceType: z.string().optional(),
      bouncedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
  complaint: z
    .object({
      complainedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
});

export interface SuppressionTarget {
  address: string;
  kind: 'bounce' | 'complaint';
}

export interface ParsedSesEvent {
  targets: SuppressionTarget[];
  messageId?: string;
}

/**
 * Turn an SNS `Message` string into suppression targets. Returns null when the
 * message is not a valid SES event (caller answers 400).
 */
export function parseSesEvent(raw: string): ParsedSesEvent | null {
  let message: z.infer<typeof sesMessage>;
  try {
    message = sesMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  const type = message.eventType ?? message.notificationType;
  if (!type) return null;

  const targets: SuppressionTarget[] = [];
  if (type === 'Bounce' && message.bounce?.bounceType === 'Permanent') {
    for (const r of message.bounce.bouncedRecipients ?? []) {
      targets.push({ address: r.emailAddress, kind: 'bounce' });
    }
  } else if (type === 'Complaint') {
    for (const r of message.complaint?.complainedRecipients ?? []) {
      targets.push({ address: r.emailAddress, kind: 'complaint' });
    }
  }
  const messageId = message.mail?.messageId;
  return messageId ? { targets, messageId } : { targets };
}
