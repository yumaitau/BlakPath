import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { INVENTORY_LOG_FIELDS } from '@/lib/encryption/inventory';
import { OPERATIONAL_REDACT_PATHS } from '@/lib/observability/logger';

describe('operational log redaction', () => {
  it('omits every inventoried field from log output', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = pino(
      { redact: { paths: OPERATIONAL_REDACT_PATHS, censor: '[redacted]' } },
      stream,
    );
    const record: Record<string, string> = {};
    const nested: Record<string, string> = {};
    for (const field of INVENTORY_LOG_FIELDS) {
      record[field] = `CANARY_${field}_PLAIN`;
      nested[field] = `CANARY_${field}_NESTED`;
    }
    log.info(record, 'top');
    log.info({ nested }, 'nested');
    const output = lines.join('\n');
    for (const field of INVENTORY_LOG_FIELDS) {
      expect(output).not.toContain(`CANARY_${field}_PLAIN`);
      expect(output).not.toContain(`CANARY_${field}_NESTED`);
    }
  });
});
