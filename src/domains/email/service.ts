import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
 * Only permanent bounces and complaints are recorded (see the events route).
 * Organisation administrators see suppressed member/invitee addresses on the
 * People screen and can clear one once the address is fixed (audited).
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

export type SuppressionKind = 'bounce' | 'complaint';

/**
 * Active suppressions for a set of addresses, keyed by the lower-cased address.
 * One query; addresses that are not suppressed are absent from the map.
 */
export async function suppressionsFor(
  addresses: readonly string[],
): Promise<Map<string, SuppressionKind>> {
  const result = new Map<string, SuppressionKind>();
  if (addresses.length === 0) return result;
  const byHash = new Map(addresses.map((a) => [hashAddress(a), a.trim().toLowerCase()]));
  const rows = await db
    .select({ addressHash: emailSuppressions.addressHash, kind: emailSuppressions.kind })
    .from(emailSuppressions)
    .where(
      and(
        inArray(emailSuppressions.addressHash, [...byHash.keys()]),
        isNull(emailSuppressions.clearedAt),
      ),
    );
  for (const row of rows) {
    const address = byHash.get(row.addressHash);
    if (address) result.set(address, row.kind === 'complaint' ? 'complaint' : 'bounce');
  }
  return result;
}

/**
 * Clear the active suppression for one address so mail resumes. The caller
 * must already have authorised the actor (organisation administrator acting on
 * a member or invitee of their own tenant). Audited against the caller's tenant
 * context (one event per cleared row). Returns false when nothing was
 * suppressed.
 */
export async function clearSuppression(
  address: string,
  target: { kind: 'membership' | 'invitation'; id: string },
): Promise<boolean> {
  const cleared = await db
    .update(emailSuppressions)
    .set({ clearedAt: new Date() })
    .where(
      and(
        eq(emailSuppressions.addressHash, hashAddress(address)),
        isNull(emailSuppressions.clearedAt),
      ),
    )
    .returning({ id: emailSuppressions.id, kind: emailSuppressions.kind });
  if (cleared.length === 0) return false;
  for (const row of cleared) {
    await recordAudit({
      action: 'email.suppression_cleared',
      resourceType: 'email_suppression',
      resourceId: row.id,
      result: 'success',
      // Which member/invitee the admin acted on; never the address itself.
      after: {
        data: { kind: row.kind, target: target.kind, targetId: target.id },
        allow: ['kind', 'target', 'targetId'],
      },
    });
  }
  return true;
}
