/**
 * Child process for the 5M-event memory ceiling. Invoked with --expose-gc and a
 * fixed V8 heap. Not a vitest file.
 */
import { computeEventHash, type HashableAuditEvent } from '../../src/domains/audit/hash';
import {
  AUDIT_VERIFY_PAGE_SIZE,
  verifyChainFromPages,
  type AuditChainCursor,
  type StoredAuditEvent,
} from '../../src/domains/audit/verify';

const TOTAL = 5_000_000;
const PAGE = AUDIT_VERIFY_PAGE_SIZE;
const CEILING_BYTES = 64 * 1024 * 1024;

const gc: () => void = (() => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect) {
    console.error('gc unavailable');
    process.exit(1);
  }
  return collect;
})();

let sequence = 0;
let prevHash: string | null = null;
let lastHash: string | null = null;
let calls = 0;
let baseline = 0;
let peakGrowth = 0;

function nextEvent(): StoredAuditEvent {
  const timestamp = new Date(sequence);
  const id = String(sequence).padStart(7, '0');
  const hashable: HashableAuditEvent = {
    id,
    organisationId: 'org',
    timestamp: timestamp.toISOString(),
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    action: 'record.viewed',
    resourceType: 'application',
    resourceId: null,
    result: 'success',
    reason: null,
    ipAddress: null,
    userAgent: null,
    correlationId: null,
    requestId: null,
    beforeMeta: null,
    afterMeta: null,
  };
  const hash = computeEventHash(prevHash, hashable);
  const row: StoredAuditEvent = {
    id,
    organisationId: 'org',
    timestamp,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    action: 'record.viewed',
    resourceType: 'application',
    resourceId: null,
    result: 'success',
    reason: null,
    ipAddress: null,
    userAgent: null,
    correlationId: null,
    requestId: null,
    beforeMeta: null,
    afterMeta: null,
    prevHash,
    hash,
  };
  prevHash = hash;
  lastHash = hash;
  sequence += 1;
  return row;
}

async function loadPage(
  _after: AuditChainCursor | null,
  limit: number,
): Promise<readonly StoredAuditEvent[]> {
  if (limit !== PAGE) {
    throw new Error(`page limit ${limit} exceeded the fixed page size`);
  }
  if (calls === 0 || calls % 50 === 0) {
    gc();
    const used = process.memoryUsage().heapUsed;
    if (calls === 0) {
      baseline = used;
    } else {
      peakGrowth = Math.max(peakGrowth, used - baseline);
    }
  }
  calls += 1;
  if (sequence >= TOTAL) {
    return [];
  }
  const count = Math.min(PAGE, TOTAL - sequence);
  const page: StoredAuditEvent[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    page[index] = nextEvent();
  }
  return page;
}

const result = await verifyChainFromPages('org', loadPage, { pageSize: PAGE });
gc();
peakGrowth = Math.max(peakGrowth, process.memoryUsage().heapUsed - baseline);

if (!result.ok || result.eventCount !== TOTAL || result.endHash !== lastHash) {
  console.error(
    `VERIFY events=${result.eventCount} ok=${result.ok} reason=${result.divergence?.reason ?? 'none'}`,
  );
  process.exit(1);
}
if (calls !== TOTAL / PAGE + 1) {
  console.error(`PAGES ${calls}`);
  process.exit(1);
}
if (peakGrowth >= CEILING_BYTES) {
  console.error(`GROWTH ${peakGrowth}`);
  process.exit(1);
}

console.log(`OK events=${result.eventCount} growth=${peakGrowth}`);
process.exit(0);
