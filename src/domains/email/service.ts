import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { emailSuppressions } from '@/db/schema';
import { recordAudit, recordPlatformAudit } from '@/domains/audit/service';

/**
 * Email suppression service — SES permanent-bounce and complaint handling.
 *
 * Prod mail goes through SES; SNS posts events to POST /api/email/events.
 * Suppressed addresses are skipped in `sendEmail` until a platform operator
 * clears them. Only address hashes persist.
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

const clearSchema = z.object({
  address: z.email().max(320),
  actorUserId: z.uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * Clear an active suppression. Platform-operator action: the address is hashed
 * and not stored, and each cleared row is audited.
 */
export async function clearSuppression(raw: {
  address: string;
  actorUserId: string;
  reason?: string;
}): Promise<{ cleared: boolean }> {
  const input = clearSchema.parse(raw);
  const updated = await db
    .update(emailSuppressions)
    .set({ clearedAt: new Date() })
    .where(
      and(
        eq(emailSuppressions.addressHash, hashAddress(input.address)),
        isNull(emailSuppressions.clearedAt),
      ),
    )
    .returning({ id: emailSuppressions.id });
  if (updated.length === 0) return { cleared: false };
  for (const row of updated) {
    await recordPlatformAudit({
      action: 'email.suppression_cleared',
      resourceType: 'email_suppression',
      resourceId: row.id,
      result: 'success',
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
    });
  }
  return { cleared: true };
}
