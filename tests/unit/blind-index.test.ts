import { createHmac, randomBytes } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { applications } from '@/db/schema';
import {
  hmacSearchTerm,
  nameTokens,
  normalizeSearchTerm,
} from '@/lib/encryption/blind-index';
import { ENCRYPTED_COLUMNS } from '@/lib/encryption/inventory';
import { plaintextResidueSql } from '@/lib/encryption/verify';

describe('blind index', () => {
  it('normalises case and whitespace and matches whole tokens only', () => {
    expect(normalizeSearchTerm('  Jane   Smith ')).toBe('jane smith');
    expect(nameTokens('Jane Smith')).toEqual(['jane smith', 'jane', 'smith']);
    const key = randomBytes(32);
    const mac = hmacSearchTerm(key, 'Jane Smith');
    expect(hmacSearchTerm(key, '  jane smith ')).toBe(mac);
    expect(hmacSearchTerm(key, 'smith')).not.toBe(mac);
    expect(createHmac('sha256', key).update('smith').digest('hex')).not.toBe(mac);
    key.fill(0);
  });

  it('does not keep a plaintext unique index on application reference or name', () => {
    const config = getTableConfig(applications);
    const names = config.indexes.map((index) => index.config.name);
    expect(names).toContain('applications_org_reference_bidx_unique');
    expect(names).toContain('applications_org_name_bidx_idx');
    expect(names).not.toContain('applications_org_reference_unique');
  });

  it('verification SQL covers every inventoried column and no plaintext lookup', () => {
    const sql = plaintextResidueSql();
    for (const column of ENCRYPTED_COLUMNS) {
      expect(sql).toContain(`${column.table}.${column.column}`);
    }
    expect(sql).not.toContain('ilike');
    expect(sql).toContain('{"v":2');
  });
});
