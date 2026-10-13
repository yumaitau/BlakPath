import { z } from 'zod';

/**
 * SES notifications that may suppress an address.
 *
 * Only a permanent bounce or a complaint. Transient and undetermined bounces
 * are ignored so a temporary delivery failure does not block later mail.
 */

const sesMessageSchema = z.object({
  notificationType: z.string(),
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

export type SesEvent = z.infer<typeof sesMessageSchema>;

export function parseSesEvent(raw: string): SesEvent | null {
  try {
    const parsed = sesMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function suppressionTargets(
  message: SesEvent,
): { address: string; kind: 'bounce' | 'complaint' }[] {
  if (message.notificationType === 'Bounce') {
    if (message.bounce?.bounceType !== 'Permanent') return [];
    return (message.bounce.bouncedRecipients ?? [])
      .map((recipient) => recipient.emailAddress)
      .filter((address) => address.length > 0)
      .map((address) => ({ address, kind: 'bounce' as const }));
  }
  if (message.notificationType === 'Complaint') {
    return (message.complaint?.complainedRecipients ?? [])
      .map((recipient) => recipient.emailAddress)
      .filter((address) => address.length > 0)
      .map((address) => ({ address, kind: 'complaint' as const }));
  }
  return [];
}
