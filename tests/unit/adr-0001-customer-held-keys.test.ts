import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locks ADR 0001 and the two docs it updates so a later edit cannot describe
 * the unimplemented custody design as code that already runs, or drop a mode
 * the decision requires.
 */

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('ADR 0001 customer-held keys', () => {
  const adr = read('docs/adr/0001-customer-held-keys.md');
  const privacy = read('docs/privacy-architecture.md');
  const threat = read('docs/threat-model.md');

  it('records every custody mode and both decision tables', () => {
    for (const mode of [
      'BlakPath-managed per-tenant key',
      'Client BYOK',
      'Client HYOK',
      'Client key + BlakPath escrow',
      'Tier 2 client-side encryption',
    ]) {
      expect(adr).toContain(mode);
    }
    expect(adr).toContain('## Custody modes');
    expect(adr).toContain('## Data classes');
    expect(adr).toContain('## Who can read plaintext');
    expect(adr).toContain('GenerateDataKey');
    expect(adr).toContain('org_id');
    expect(adr).toContain('purpose');
    expect(adr).toContain('5 minutes');
    expect(adr).toContain('plaintext in');
  });

  it('covers escrow threats, release, and the regulatory notes', () => {
    expect(adr).toContain('Insider at BlakPath');
    expect(adr).toContain('Coercion');
    expect(adr).toContain('Lost custodians');
    expect(adr).toContain('## Release governance');
    expect(adr).toContain('APP 11');
    expect(adr).toContain('#43');
    expect(adr).toContain('#80');
    expect(adr).toContain('explicit');
    expect(adr).toContain('Not implemented');
  });

  it('does not describe the env master key as a KMS-managed control', () => {
    expect(adr).not.toContain('sourced from KMS');
    expect(privacy).not.toContain('sourced from KMS');
    expect(privacy).toContain('does not call KMS');
    expect(privacy).toContain('adr/0001-customer-held-keys.md');
    expect(privacy).toContain('XChaCha20-Poly1305');
    expect(privacy).toContain('plaintext in PostgreSQL');
  });

  it('adds STRIDE entries for key custody and escrow', () => {
    const section = threat
      .split('## Key custody and escrow')[1]
      ?.split('## Fail-secure')[0];
    expect(section).toBeTruthy();
    for (const stride of [
      'Spoofing',
      'Tampering',
      'Repudiation',
      'Information disclosure',
      'Denial of service',
      'Elevation of privilege',
    ]) {
      expect(section).toContain(stride);
    }
    expect(section).toContain('Escrow threats');
    expect(section).toContain('Not implemented');
    expect(section).toContain('Insider at BlakPath');
    expect(section).toContain('Coercion');
    expect(section).toContain('Lost custodians');
  });
});
