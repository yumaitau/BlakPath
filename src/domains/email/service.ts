import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { emailSuppressions } from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';

/**
 * Email suppression service — SES bounce/complaint handling.
 *
 * Prod mail goes through SES (SMTP interface); SES posts bounce/complaint
 * events via SNS to POST /api/email/events. Suppressed addresses are skipped
 * in `sendEmail` until explicitly cleared. Only address hashes persist.
 */

/** SHA-256 hex of lower-cased address. No plaintext PII stored. */
export function hashAddress(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

export async function isSuppressed(address: string): Promise<boolean> {
  const rows = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.addressHash, hashAddress(address)),
        isNull(emailSuppressions.clearedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const recordSchema = z.object({
  address: z.email().max(320),
  kind: z.enum(['bounce', 'complaint']).optional(),
  sourceMessageId: z.string().max(200).optional(),
});

/** Record a suppression from a verified SNS event. Idempotent per address. */
export async function recordSuppression(raw: {
  address: string;
  kind?: 'bounce' | 'complaint';
  sourceMessageId?: string;
}): Promise<{ suppressed: boolean }> {
  const input = recordSchema.parse(raw);
  const addressHash = hashAddress(input.address);
  const existing = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.addressHash, addressHash),
        isNull(emailSuppressions.clearedAt),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { suppressed: true };
  const inserted = await db
    .insert(emailSuppressions)
    .values({
      addressHash,
      kind: input.kind ?? 'bounce',
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .returning({ id: emailSuppressions.id });
  await recordAudit({
    action: 'email.suppressed',
    resourceType: 'email_suppression',
    resourceId: inserted[0]?.id ?? null,
    result: 'success',
    organisationId: null,
  });
  return { suppressed: true };
}
