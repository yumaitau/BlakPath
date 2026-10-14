import { createHash } from 'node:crypto';
import { canonicalise, type JsonValue } from './hash';

/**
 * Signed chain-head anchors stored outside the database.
 *
 * The audit hash is an unkeyed digest, so a rewritten chain still verifies
 * against itself. Each anchor commits to the head hash and event count at a
 * UTC day, and to the previous anchor. Verification requires every historical
 * anchor's head to still sit at that index in the current chain. Deleting the
 * tail, or replacing the chain with a freshly hashed one, fails that check.
 * Object lock on the bucket is what stops the anchor objects themselves from
 * being removed; this module only reads and appends them.
 */

export const PLATFORM_CHAIN_ID = 'platform';

export type AnchorMismatchReason =
  | 'signature_invalid'
  | 'prev_anchor_mismatch'
  | 'count_regressed'
  | 'head_changed'
  | 'chain_truncated'
  | 'head_mismatch'
  | 'chain_mismatch'
  | 'unreadable_anchor'
  | 'anchor_in_future';

export interface AnchorBody {
  readonly v: 1;
  readonly chainId: string;
  readonly organisationId: string | null;
  readonly day: string;
  readonly eventCount: number;
  readonly chainHeadHash: string;
  readonly prevAnchorHash: string | null;
  readonly anchoredAt: string;
}

export interface SignedAuditAnchor extends AnchorBody {
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly signatureB64: string;
  };
}

export interface AnchorSignature {
  readonly signatureB64: string;
  readonly algorithm: string;
  readonly keyId: string;
}

export interface AnchorSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(canonical: string): Promise<AnchorSignature>;
  verify(
    canonical: string,
    signatureB64: string,
    keyId: string,
    algorithm: string,
  ): Promise<boolean>;
}

export interface AuditAnchorStore {
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  put(key: string, body: string): Promise<void>;
}

/** Chain hashes by 0-based position. May be sparse; `length` is the chain length. */
export type ChainHashes = ArrayLike<string | undefined>;

export interface AnchoredChainView {
  readonly ok: boolean;
  readonly hashes: ChainHashes;
  readonly eventCount: number;
}

/**
 * A chain too large to hold. `hashesAt` returns a sparse view of length
 * `eventCount` holding the stored hash at each requested position: every
 * anchored head and the current head.
 */
export interface AnchoredChainProbe {
  readonly ok: boolean;
  readonly eventCount: number;
  hashesAt(positions: readonly number[]): Promise<ChainHashes>;
}

export type SettleAuditChainStatus =
  | 'empty'
  | 'divergence'
  | 'anchor_mismatch'
  | 'anchored'
  | 'already_anchored';

export interface SettleAuditChainResult {
  readonly status: SettleAuditChainStatus;
  readonly reason: AnchorMismatchReason | null;
  readonly eventCount: number;
  readonly day: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function auditChainId(organisationId: string | null): string {
  if (organisationId === null) return PLATFORM_CHAIN_ID;
  if (!UUID.test(organisationId)) {
    throw new Error('Audit chain id must be an organisation uuid');
  }
  return organisationId;
}

export function anchorDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function anchorObjectKey(chainId: string, day: string): string {
  if (chainId !== PLATFORM_CHAIN_ID && !UUID.test(chainId)) {
    throw new Error('Audit anchor key rejected an unsafe chain id');
  }
  if (!DAY.test(day)) throw new Error('Audit anchor key rejected an unsafe day');
  return `audit-anchors/${chainId}/${day}.json`;
}

export function anchorPrefix(chainId: string): string {
  if (chainId !== PLATFORM_CHAIN_ID && !UUID.test(chainId)) {
    throw new Error('Audit anchor prefix rejected an unsafe chain id');
  }
  return `audit-anchors/${chainId}/`;
}

export function canonicalAnchorBody(body: AnchorBody): string {
  const payload: { [key: string]: JsonValue } = {
    v: body.v,
    chainId: body.chainId,
    organisationId: body.organisationId,
    day: body.day,
    eventCount: body.eventCount,
    chainHeadHash: body.chainHeadHash,
    prevAnchorHash: body.prevAnchorHash,
    anchoredAt: body.anchoredAt,
  };
  return canonicalise(payload);
}

export function hashAnchorBody(body: AnchorBody): string {
  return createHash('sha256').update(canonicalAnchorBody(body), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSignedAnchor(raw: string): SignedAuditAnchor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if (typeof parsed.chainId !== 'string' || typeof parsed.day !== 'string') return null;
  if (!DAY.test(parsed.day)) return null;
  if (typeof parsed.eventCount !== 'number' || !Number.isInteger(parsed.eventCount)) {
    return null;
  }
  if (parsed.eventCount < 1) return null;
  if (typeof parsed.chainHeadHash !== 'string' || parsed.chainHeadHash.length === 0) {
    return null;
  }
  if (parsed.organisationId !== null && typeof parsed.organisationId !== 'string') {
    return null;
  }
  if (parsed.prevAnchorHash !== null && typeof parsed.prevAnchorHash !== 'string') {
    return null;
  }
  if (typeof parsed.anchoredAt !== 'string') return null;
  if (!isRecord(parsed.signature)) return null;
  const signature = parsed.signature;
  if (
    typeof signature.algorithm !== 'string' ||
    typeof signature.keyId !== 'string' ||
    typeof signature.signatureB64 !== 'string'
  ) {
    return null;
  }
  return {
    v: 1,
    chainId: parsed.chainId,
    organisationId: parsed.organisationId,
    day: parsed.day,
    eventCount: parsed.eventCount,
    chainHeadHash: parsed.chainHeadHash,
    prevAnchorHash: parsed.prevAnchorHash,
    anchoredAt: parsed.anchoredAt,
    signature: {
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      signatureB64: signature.signatureB64,
    },
  };
}

function anchorBody(anchor: SignedAuditAnchor): AnchorBody {
  return {
    v: anchor.v,
    chainId: anchor.chainId,
    organisationId: anchor.organisationId,
    day: anchor.day,
    eventCount: anchor.eventCount,
    chainHeadHash: anchor.chainHeadHash,
    prevAnchorHash: anchor.prevAnchorHash,
    anchoredAt: anchor.anchoredAt,
  };
}

function byAge(left: SignedAuditAnchor, right: SignedAuditAnchor): number {
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  if (left.anchoredAt !== right.anchoredAt) {
    return left.anchoredAt < right.anchoredAt ? -1 : 1;
  }
  return 0;
}

export async function assessAnchoredChain(
  chainId: string,
  organisationId: string | null,
  chainHashes: ChainHashes,
  anchors: readonly SignedAuditAnchor[],
  signer: AnchorSigner,
): Promise<
  { ok: true } | { ok: false; reason: AnchorMismatchReason; day: string | null }
> {
  const sorted = [...anchors].sort(byAge);
  let previous: AnchorBody | null = null;
  for (const anchor of sorted) {
    if (anchor.chainId !== chainId || anchor.organisationId !== organisationId) {
      return { ok: false, reason: 'chain_mismatch', day: anchor.day };
    }
    const body = anchorBody(anchor);
    const valid = await signer.verify(
      canonicalAnchorBody(body),
      anchor.signature.signatureB64,
      anchor.signature.keyId,
      anchor.signature.algorithm,
    );
    if (!valid) return { ok: false, reason: 'signature_invalid', day: anchor.day };
    const expectedPrev = previous ? hashAnchorBody(previous) : null;
    if (anchor.prevAnchorHash !== expectedPrev) {
      return { ok: false, reason: 'prev_anchor_mismatch', day: anchor.day };
    }
    if (previous && anchor.eventCount < previous.eventCount) {
      return { ok: false, reason: 'count_regressed', day: anchor.day };
    }
    if (
      previous &&
      anchor.eventCount === previous.eventCount &&
      anchor.chainHeadHash !== previous.chainHeadHash
    ) {
      return { ok: false, reason: 'head_changed', day: anchor.day };
    }
    if (chainHashes.length < anchor.eventCount) {
      return { ok: false, reason: 'chain_truncated', day: anchor.day };
    }
    if (chainHashes[anchor.eventCount - 1] !== anchor.chainHeadHash) {
      return { ok: false, reason: 'head_mismatch', day: anchor.day };
    }
    previous = body;
  }
  return { ok: true };
}

async function readAnchors(
  store: AuditAnchorStore,
  chainId: string,
): Promise<SignedAuditAnchor[] | AnchorMismatchReason> {
  const keys = await store.list(anchorPrefix(chainId));
  const anchors: SignedAuditAnchor[] = [];
  for (const key of keys) {
    if (!key.endsWith('.json')) continue;
    const raw = await store.get(key);
    if (raw === null) continue;
    const parsed = parseSignedAnchor(raw);
    if (!parsed) return 'unreadable_anchor';
    anchors.push(parsed);
  }
  return anchors;
}

/**
 * Compare the current chain to every stored anchor, then write today's head
 * when it is not already recorded. A mismatch does not throw: retrying will
 * not repair a rewritten chain. Store outages throw so the job can retry.
 */
export async function settleAuditChain(input: {
  organisationId: string | null;
  chain: AnchoredChainView | AnchoredChainProbe;
  store: AuditAnchorStore;
  signer: AnchorSigner;
  now?: Date;
}): Promise<SettleAuditChainResult> {
  const now = input.now ?? new Date();
  const day = anchorDay(now);
  if (!input.chain.ok) {
    return {
      status: 'divergence',
      reason: null,
      eventCount: input.chain.eventCount,
      day: null,
    };
  }
  const fullView = 'hashes' in input.chain ? input.chain.hashes : null;
  if (input.chain.eventCount === 0 || fullView?.length === 0) {
    return { status: 'empty', reason: null, eventCount: 0, day: null };
  }

  const chainId = auditChainId(input.organisationId);
  const loaded = await readAnchors(input.store, chainId);
  if (typeof loaded === 'string') {
    return {
      status: 'anchor_mismatch',
      reason: loaded,
      eventCount: input.chain.eventCount,
      day: null,
    };
  }
  const hashes: ChainHashes =
    'hashes' in input.chain
      ? input.chain.hashes
      : await input.chain.hashesAt([
          ...loaded.map((anchor) => anchor.eventCount - 1),
          input.chain.eventCount - 1,
        ]);
  const assessment = await assessAnchoredChain(
    chainId,
    input.organisationId,
    hashes,
    loaded,
    input.signer,
  );
  if (!assessment.ok) {
    return {
      status: 'anchor_mismatch',
      reason: assessment.reason,
      eventCount: input.chain.eventCount,
      day: assessment.day,
    };
  }
  if (loaded.some((anchor) => anchor.day > day)) {
    return {
      status: 'anchor_mismatch',
      reason: 'anchor_in_future',
      eventCount: input.chain.eventCount,
      day,
    };
  }

  const key = anchorObjectKey(chainId, day);
  const existingRaw = await input.store.get(key);
  if (existingRaw !== null) {
    const existing = parseSignedAnchor(existingRaw);
    const prefixOk =
      existing !== null &&
      hashes.length >= existing.eventCount &&
      hashes[existing.eventCount - 1] === existing.chainHeadHash;
    if (!prefixOk) {
      return {
        status: 'anchor_mismatch',
        reason: existing ? 'head_mismatch' : 'unreadable_anchor',
        eventCount: input.chain.eventCount,
        day,
      };
    }
    return {
      status: 'already_anchored',
      reason: null,
      eventCount: input.chain.eventCount,
      day,
    };
  }

  const previous = [...loaded].sort(byAge).at(-1) ?? null;
  const head = hashes[hashes.length - 1];
  if (!head) {
    return { status: 'empty', reason: null, eventCount: 0, day: null };
  }
  const body: AnchorBody = {
    v: 1,
    chainId,
    organisationId: input.organisationId,
    day,
    eventCount: hashes.length,
    chainHeadHash: head,
    prevAnchorHash: previous ? hashAnchorBody(previous) : null,
    anchoredAt: now.toISOString(),
  };
  const signature = await input.signer.sign(canonicalAnchorBody(body));
  const document: SignedAuditAnchor = {
    ...body,
    signature,
  };
  await input.store.put(key, JSON.stringify(document));
  return {
    status: 'anchored',
    reason: null,
    eventCount: body.eventCount,
    day,
  };
}
