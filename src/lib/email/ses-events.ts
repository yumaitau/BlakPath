import { z } from 'zod';

const recipient = z.object({ emailAddress: z.string().min(3) });

/**
 * SES has two SNS shapes. Identity notifications use `notificationType`.
 * Configuration-set event destinations use `eventType`. Both carry the same
 * bounce and complaint recipient lists.
 */
const sesMessage = z.object({
  notificationType: z.string().optional(),
  eventType: z.string().optional(),
  mail: z.object({ messageId: z.string().optional() }).optional(),
  bounce: z
    .object({
      bouncedRecipients: z.array(recipient).optional(),
    })
    .optional(),
  complaint: z
    .object({
      complainedRecipients: z.array(recipient).optional(),
    })
    .optional(),
});

export type SesSuppression = {
  address: string;
  kind: 'bounce' | 'complaint';
  sourceMessageId?: string;
};

export type ParsedSesEvent =
  | { status: 'invalid' }
  | { status: 'ignored' }
  | { status: 'actionable'; targets: SesSuppression[] };

export function parseSesEvent(input: unknown): ParsedSesEvent {
  const parsed = sesMessage.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };

  const kind = parsed.data.notificationType ?? parsed.data.eventType;
  if (kind !== 'Bounce' && kind !== 'Complaint') return { status: 'ignored' };

  const sourceMessageId = parsed.data.mail?.messageId;
  const addresses =
    kind === 'Bounce'
      ? (parsed.data.bounce?.bouncedRecipients ?? []).map((item) => item.emailAddress)
      : (parsed.data.complaint?.complainedRecipients ?? []).map(
          (item) => item.emailAddress,
        );

  return {
    status: 'actionable',
    targets: addresses.map((address) => ({
      address,
      kind: kind === 'Bounce' ? 'bounce' : 'complaint',
      ...(sourceMessageId ? { sourceMessageId } : {}),
    })),
  };
}
