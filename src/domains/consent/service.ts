import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import {
  clients,
  consentEvents,
  consentWordingVersions,
  representativeAuthorisations,
} from '@/db/schema';
import { currentScope, type TenantScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  channelForMethod,
  consentState,
  nextWordingVersion,
  withdrawalEffects,
  type ConsentPurpose,
  type ConsentState,
} from './rules';
import {
  consentSubjectSchema,
  publishWordingSchema,
  recordConsentSchema,
  withdrawConsentSchema,
  type ConsentSubjectInput,
  type PublishWordingInput,
  type RecordConsentInput,
  type WithdrawConsentInput,
} from './schemas';

/**
 * Consent ledger service — tenant-scoped, permission-checked, audited.
 *
 * Grants and withdrawals are appended to `consent_events`; nothing is ever
 * updated or deleted (the database enforces this). Each grant references the
 * wording version shown and records how consent was given and its evidence.
 *
 * Two channels, decided by the method:
 *  - staff         — intake/case staff record consent given on a signed form,
 *                    verbally with a witness, or by written request. Works for
 *                    people with no account via their `clients` record.
 *  - self-service  — the person (or their active representative) acknowledges
 *                    or withdraws online while signed in. Withdrawal by the
 *                    person themselves never needs a staff permission.
 */

export type ConsentEventRow = typeof consentEvents.$inferSelect;
export type ConsentWordingRow = typeof consentWordingVersions.$inferSelect;

/** A grant with its derived state and (if any) the withdrawal that ended it. */
export interface ConsentView {
  grant: ConsentEventRow;
  withdrawal: ConsentEventRow | null;
  state: ConsentState;
}

export interface WithdrawalResult {
  withdrawal: ConsentEventRow;
  revokedRepresentativeAuthorisationIds: string[];
}

const STAFF_WRITE = ['application:update-intake', 'application:assign'] as const;
const STAFF_READ = [
  ...STAFF_WRITE,
  'application:read-any',
  'application:read-assigned',
  'client:read-any',
  'client:read-assigned',
] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/* ---------------------------------------------------------------------------
 * Wording versions
 * ------------------------------------------------------------------------- */

/** Publish a new, immutable wording version (`tenant:configure`). */
export async function publishWordingVersion(
  raw: PublishWordingInput,
): Promise<ConsentWordingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = publishWordingSchema.parse(raw);
  const scope = currentScope();
  const latest = await scope.db
    .select({ version: consentWordingVersions.version })
    .from(consentWordingVersions)
    .where(
      scope.where(
        consentWordingVersions.organisationId,
        eq(consentWordingVersions.purpose, input.purpose),
      ),
    )
    .orderBy(desc(consentWordingVersions.version))
    .limit(1);
  const inserted = await scope.db
    .insert(consentWordingVersions)
    .values(
      scope.insertValues({
        purpose: input.purpose,
        version: nextWordingVersion(latest[0]?.version),
        locale: input.locale,
        title: input.title,
        body: input.body,
        bodySha256: sha256(input.body),
        publishedByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = must(inserted[0], 'consent wording version');
  await recordAudit({
    action: 'consent.wording_published',
    resourceType: 'consent_wording',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { purpose: row.purpose, version: row.version, locale: row.locale },
      allow: ['purpose', 'version', 'locale'],
    },
  });
  return row;
}

/**
 * Wording versions, newest first. Readable by any member of the organisation:
 * a person must be able to read the words before acknowledging them.
 */
export async function listWordingVersions(
  purpose?: ConsentPurpose,
): Promise<ConsentWordingRow[]> {
  requireTenantContext();
  const scope = currentScope();
  return scope.db
    .select()
    .from(consentWordingVersions)
    .where(
      scope.where(
        consentWordingVersions.organisationId,
        purpose ? eq(consentWordingVersions.purpose, purpose) : undefined,
      ),
    )
    .orderBy(asc(consentWordingVersions.purpose), desc(consentWordingVersions.version));
}

/* ---------------------------------------------------------------------------
 * Subject resolution and actor checks
 * ------------------------------------------------------------------------- */

interface ResolvedSubject {
  subjectUserId: string | null;
  subjectClientId: string | null;
}

/**
 * Resolve the person from an account id and/or client record. A client that
 * is linked to an account carries that account id onto the event; a mismatch
 * between the two is refused.
 */
async function resolveSubject(
  scope: TenantScope,
  input: { subjectUserId?: string | undefined; subjectClientId?: string | undefined },
): Promise<ResolvedSubject> {
  if (!input.subjectClientId) {
    return { subjectUserId: input.subjectUserId ?? null, subjectClientId: null };
  }
  const rows = await scope.db
    .select({
      id: clients.id,
      organisationId: clients.organisationId,
      linkedUserId: clients.linkedUserId,
    })
    .from(clients)
    .where(
      scope.where(
        clients.organisationId,
        eq(clients.id, input.subjectClientId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);
  const client = scope.assertOwned(rows[0]);
  if (!client) throw new AuthorizationError('POLICY_DENIED');
  if (
    input.subjectUserId &&
    client.linkedUserId &&
    input.subjectUserId !== client.linkedUserId
  ) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return {
    subjectUserId: input.subjectUserId ?? client.linkedUserId ?? null,
    subjectClientId: client.id,
  };
}

/** Does `representativeUserId` hold active, unexpired access for the subject? */
async function hasActiveRepresentation(
  scope: TenantScope,
  representativeUserId: string,
  subjectUserId: string | null,
): Promise<boolean> {
  if (!subjectUserId) return false;
  const rows = await scope.db
    .select({ id: representativeAuthorisations.id })
    .from(representativeAuthorisations)
    .where(
      scope.where(
        representativeAuthorisations.organisationId,
        eq(representativeAuthorisations.subjectUserId, subjectUserId),
        eq(representativeAuthorisations.representativeUserId, representativeUserId),
        eq(representativeAuthorisations.status, 'active'),
        isNull(representativeAuthorisations.revokedAt),
        or(
          isNull(representativeAuthorisations.expiresAt),
          gt(representativeAuthorisations.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Self-service acts: the signed-in person must BE the subject (givenBy
 * `subject`), or hold active representative access for them.
 */
async function assertSelfServiceActor(
  scope: TenantScope,
  ctx: TenantContext,
  subject: ResolvedSubject,
  givenBy: string,
  extraAllowedUserId?: string | null,
): Promise<void> {
  if (givenBy === 'subject') {
    if (subject.subjectUserId === ctx.userId) return;
  } else if (
    (extraAllowedUserId && extraAllowedUserId === ctx.userId) ||
    (await hasActiveRepresentation(scope, ctx.userId, subject.subjectUserId))
  ) {
    return;
  }
  throw new AuthorizationError('POLICY_DENIED');
}

/* ---------------------------------------------------------------------------
 * Grants
 * ------------------------------------------------------------------------- */

/** Record a consent grant (append-only). */
export async function recordConsent(raw: RecordConsentInput): Promise<ConsentEventRow> {
  const ctx = requireTenantContext();
  const input = recordConsentSchema.parse(raw);
  const channel = channelForMethod(input.method);
  if (channel === 'staff') requireAny(subjectFromContext(ctx), STAFF_WRITE);

  const scope = currentScope();
  const subject = await resolveSubject(scope, input);
  if (channel === 'self-service') {
    await assertSelfServiceActor(scope, ctx, subject, input.givenBy);
  }

  const wording = await scope.db
    .select({
      id: consentWordingVersions.id,
      organisationId: consentWordingVersions.organisationId,
      purpose: consentWordingVersions.purpose,
    })
    .from(consentWordingVersions)
    .where(
      scope.where(
        consentWordingVersions.organisationId,
        eq(consentWordingVersions.id, input.wordingVersionId),
      ),
    )
    .limit(1);
  const version = scope.assertOwned(wording[0]);
  if (!version || version.purpose !== input.purpose) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const inserted = await scope.db
    .insert(consentEvents)
    .values(
      scope.insertValues({
        kind: 'granted',
        subjectUserId: subject.subjectUserId,
        subjectClientId: subject.subjectClientId,
        purpose: input.purpose,
        wordingVersionId: version.id,
        sharingRecipient: input.sharingRecipient ?? null,
        method: input.method,
        evidenceReference: input.evidenceReference ?? null,
        witnessName: input.witnessName ?? null,
        givenBy: input.givenBy,
        representativeName: input.representativeName ?? null,
        representativeRelationship: input.representativeRelationship ?? null,
        representativeUserId:
          channel === 'self-service' && input.givenBy !== 'subject'
            ? ctx.userId
            : (input.representativeUserId ?? null),
        channel,
        actorUserId: ctx.userId,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      }),
    )
    .returning();
  const row = must(inserted[0], 'consent event');
  await recordAudit({
    action: 'consent.recorded',
    resourceType: 'consent',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        purpose: row.purpose,
        wordingVersionId: row.wordingVersionId,
        method: row.method,
        givenBy: row.givenBy,
        channel: row.channel,
      },
      allow: ['purpose', 'wordingVersionId', 'method', 'givenBy', 'channel'],
    },
  });
  return row;
}

/* ---------------------------------------------------------------------------
 * Withdrawal
 * ------------------------------------------------------------------------- */

/**
 * Withdraw a grant. Appends a `withdrawn` event (never edits the grant), then
 * runs downstream effects in the same transaction — withdrawing
 * `representative-access` revokes every pending/active authorisation it backs.
 */
export async function withdrawConsent(
  grantId: string,
  raw: WithdrawConsentInput,
): Promise<WithdrawalResult> {
  const ctx = requireTenantContext();
  const input = withdrawConsentSchema.parse(raw);
  const channel = channelForMethod(input.method);
  if (channel === 'staff') requireAny(subjectFromContext(ctx), STAFF_WRITE);

  const scope = currentScope();
  const grant = await loadGrant(scope, grantId);
  if (!grant) throw new AuthorizationError('POLICY_DENIED');
  if (channel === 'self-service') {
    await assertSelfServiceActor(
      scope,
      ctx,
      { subjectUserId: grant.subjectUserId, subjectClientId: grant.subjectClientId },
      input.givenBy,
      grant.representativeUserId,
    );
  }

  const outcome = await scope.db.transaction(async (tx) => {
    // Lock the grant so concurrent withdrawals serialise; the unique index on
    // grant_event_id is the backstop.
    await tx
      .select({ id: consentEvents.id })
      .from(consentEvents)
      .where(scope.where(consentEvents.organisationId, eq(consentEvents.id, grant.id)))
      .for('update');
    const existing = await tx
      .select({ id: consentEvents.id })
      .from(consentEvents)
      .where(
        scope.where(
          consentEvents.organisationId,
          eq(consentEvents.grantEventId, grant.id),
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;

    const inserted = await tx
      .insert(consentEvents)
      .values(
        scope.insertValues({
          kind: 'withdrawn',
          grantEventId: grant.id,
          subjectUserId: grant.subjectUserId,
          subjectClientId: grant.subjectClientId,
          purpose: grant.purpose,
          method: input.method,
          evidenceReference: input.evidenceReference ?? null,
          witnessName: input.witnessName ?? null,
          givenBy: input.givenBy,
          representativeName: input.representativeName ?? null,
          representativeRelationship: input.representativeRelationship ?? null,
          representativeUserId:
            channel === 'self-service' && input.givenBy !== 'subject'
              ? ctx.userId
              : (input.representativeUserId ?? null),
          channel,
          actorUserId: ctx.userId,
          notes: input.notes ?? null,
        }),
      )
      .returning();
    const withdrawal = must(inserted[0], 'consent withdrawal');

    let revoked: string[] = [];
    if (
      withdrawalEffects(grant.purpose as ConsentPurpose).includes(
        'revoke-representative-access',
      )
    ) {
      const rows = await tx
        .update(representativeAuthorisations)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(
          scope.where(
            representativeAuthorisations.organisationId,
            eq(representativeAuthorisations.consentEventId, grant.id),
            inArray(representativeAuthorisations.status, ['pending', 'active']),
          ),
        )
        .returning({ id: representativeAuthorisations.id });
      revoked = rows.map((r) => r.id);
    }
    return { withdrawal, revokedRepresentativeAuthorisationIds: revoked };
  });

  if (!outcome) {
    await recordAudit({
      action: 'consent.withdrawn',
      resourceType: 'consent',
      resourceId: grant.id,
      result: 'denied',
      reason: 'already withdrawn',
    });
    throw new AuthorizationError('POLICY_DENIED', 'This consent is already withdrawn.');
  }

  for (const id of outcome.revokedRepresentativeAuthorisationIds) {
    await recordAudit({
      action: 'representative.revoked',
      resourceType: 'representative_authorisation',
      resourceId: id,
      result: 'success',
      reason: 'consent withdrawn',
    });
  }
  await recordAudit({
    action: 'consent.withdrawn',
    resourceType: 'consent',
    resourceId: grant.id,
    result: 'success',
    after: {
      data: {
        withdrawalEventId: outcome.withdrawal.id,
        method: outcome.withdrawal.method,
        channel: outcome.withdrawal.channel,
        revokedRepresentativeAuthorisations:
          outcome.revokedRepresentativeAuthorisationIds.length,
      },
      allow: [
        'withdrawalEventId',
        'method',
        'channel',
        'revokedRepresentativeAuthorisations',
      ],
    },
  });
  return outcome;
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

async function loadGrant(
  scope: TenantScope,
  grantId: string,
): Promise<ConsentEventRow | undefined> {
  const rows = await scope.db
    .select()
    .from(consentEvents)
    .where(
      scope.where(
        consentEvents.organisationId,
        eq(consentEvents.id, grantId),
        eq(consentEvents.kind, 'granted'),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]);
}

/** Grants matching `predicate`, each joined to its withdrawal and state. */
async function loadViews(
  scope: TenantScope,
  predicate: SQL | undefined,
): Promise<ConsentView[]> {
  const grants = await scope.db
    .select()
    .from(consentEvents)
    .where(
      scope.where(
        consentEvents.organisationId,
        eq(consentEvents.kind, 'granted'),
        predicate,
      ),
    )
    .orderBy(asc(consentEvents.occurredAt));
  if (grants.length === 0) return [];
  const withdrawals = await scope.db
    .select()
    .from(consentEvents)
    .where(
      scope.where(
        consentEvents.organisationId,
        inArray(
          consentEvents.grantEventId,
          grants.map((g) => g.id),
        ),
      ),
    );
  const byGrant = new Map(withdrawals.map((w) => [w.grantEventId, w]));
  const now = new Date();
  return grants.map((grant) => {
    const withdrawal = byGrant.get(grant.id) ?? null;
    return { grant, withdrawal, state: consentState(grant, withdrawal !== null, now) };
  });
}

function subjectPredicate(subject: ConsentSubjectInput): SQL | undefined {
  return or(
    subject.subjectUserId
      ? eq(consentEvents.subjectUserId, subject.subjectUserId)
      : undefined,
    subject.subjectClientId
      ? eq(consentEvents.subjectClientId, subject.subjectClientId)
      : undefined,
  );
}

/** Staff view of a person's consent history (account and/or client record). */
export async function listConsents(raw: ConsentSubjectInput): Promise<ConsentView[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), STAFF_READ);
  const subject = consentSubjectSchema.parse(raw);
  const views = await loadViews(currentScope(), subjectPredicate(subject));
  await recordAudit({
    action: 'consent.viewed',
    resourceType: 'consent',
    resourceId: subject.subjectClientId ?? subject.subjectUserId ?? null,
    result: 'success',
  });
  return views;
}

/**
 * The signed-in person's own consents — by account, or through any client
 * record linked to their account. No staff permission needed.
 */
export async function listMyConsents(): Promise<ConsentView[]> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const linked = await scope.db
    .select({ id: clients.id })
    .from(clients)
    .where(scope.where(clients.organisationId, eq(clients.linkedUserId, ctx.userId)));
  return loadViews(
    scope,
    or(
      eq(consentEvents.subjectUserId, ctx.userId),
      linked.length > 0
        ? inArray(
            consentEvents.subjectClientId,
            linked.map((c) => c.id),
          )
        : undefined,
    ),
  );
}

/** True when a live (granted, unwithdrawn, unexpired) grant exists. */
export async function hasLiveConsent(
  raw: ConsentSubjectInput,
  purpose: ConsentPurpose,
): Promise<boolean> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), STAFF_READ);
  const subject = consentSubjectSchema.parse(raw);
  const views = await loadViews(
    currentScope(),
    and(subjectPredicate(subject), eq(consentEvents.purpose, purpose)),
  );
  return views.some((v) => v.state === 'live');
}

/**
 * Is `grantId` a live grant for this subject and purpose? Used by other
 * domains (representative access) inside their own permission checks.
 */
export async function isLiveGrant(
  scope: TenantScope,
  grantId: string,
  expected: { subjectUserId: string; purpose: ConsentPurpose },
): Promise<boolean> {
  const [view] = await loadViews(scope, eq(consentEvents.id, grantId));
  return Boolean(
    view &&
    view.state === 'live' &&
    view.grant.subjectUserId === expected.subjectUserId &&
    view.grant.purpose === expected.purpose,
  );
}
