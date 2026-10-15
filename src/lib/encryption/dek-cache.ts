import { createHash } from 'node:crypto';

/** Hard ceiling. Constructors refuse anything longer. */
export const DEK_CACHE_MAX_TTL_MS = 5 * 60 * 1000;

export interface DekCacheOptions {
  ttlMs: number;
  maxUses: number;
  maxEntries?: number;
  now?: () => number;
  /** Called with the already-zeroed buffer after an entry is dropped. */
  onEvict?: (zeroed: Buffer) => void;
}

interface Entry {
  dek: Buffer;
  orgId: string;
  expiresAt: number;
  uses: number;
}

/**
 * Process-local cache of unwrapped data keys. Never written to Redis, disk,
 * or logs. Entries die on TTL, on use count, or when a tenant key is marked
 * unavailable. Eviction zeroes the buffer.
 */
export class DekCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxUses: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onEvict?: (zeroed: Buffer) => void;

  constructor(options: DekCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('DEK cache TTL must be a positive number of milliseconds');
    }
    if (options.ttlMs > DEK_CACHE_MAX_TTL_MS) {
      throw new Error('DEK cache TTL must be at most 5 minutes');
    }
    if (!Number.isInteger(options.maxUses) || options.maxUses < 1) {
      throw new Error('DEK cache max uses must be a positive integer');
    }
    this.ttlMs = options.ttlMs;
    this.maxUses = options.maxUses;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
    if (options.onEvict) this.onEvict = options.onEvict;
  }

  get(key: string): Buffer | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt || entry.uses >= this.maxUses) {
      this.evict(key);
      return null;
    }
    entry.uses += 1;
    const copy = Buffer.from(entry.dek);
    if (entry.uses >= this.maxUses) this.evict(key);
    return copy;
  }

  set(key: string, dek: Buffer, orgId: string): void {
    this.evict(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    this.entries.set(key, {
      dek: Buffer.from(dek),
      orgId,
      expiresAt: this.now() + this.ttlMs,
      uses: 0,
    });
  }

  evictOrganisation(orgId: string): void {
    const keys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.orgId === orgId) keys.push(key);
    }
    for (const key of keys) this.evict(key);
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.dek.fill(0);
    this.onEvict?.(entry.dek);
  }
}

let shared: DekCache | null = null;

/** One cache for the process. Tests pass their own instance. */
export function sharedDekCache(): DekCache {
  shared ??= new DekCache({ ttlMs: DEK_CACHE_MAX_TTL_MS, maxUses: 64 });
  return shared;
}

export function dekCacheKey(
  keyArn: string,
  encryptionContext: Readonly<Record<string, string>>,
  wrappedDek: Buffer,
): string {
  const context = Object.keys(encryptionContext)
    .sort()
    .map((key) => `${key}=${encryptionContext[key] ?? ''}`)
    .join('\n');
  return createHash('sha256')
    .update(keyArn)
    .update('\0')
    .update(context)
    .update('\0')
    .update(wrappedDek)
    .digest('hex');
}
