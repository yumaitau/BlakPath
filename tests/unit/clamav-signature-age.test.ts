import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAMAV_SIGNATURE_STALE_AFTER_MS,
  parseClamdVersion,
  signatureAgeSignal,
} from '@/lib/scanning/signature-age';
import { ClamAvProtocolError } from '@/lib/scanning/clamav';

const HOUR_MS = 60 * 60 * 1000;
const builtAt = new Date('2026-10-12T08:34:55.000Z');
const versionReply = 'ClamAV 1.4.3/27721/Mon Oct 12 08:34:55 2026';

describe('clamd VERSION parsing', () => {
  it('reads the database build time as UTC', () => {
    expect(parseClamdVersion(`${versionReply}\0`)).toEqual({
      version: '1.4.3',
      databaseVersion: 27721,
      databaseBuiltAt: builtAt,
    });
  });

  it('rejects replies that do not carry a database timestamp', () => {
    expect(() => parseClamdVersion('PONG')).toThrow(ClamAvProtocolError);
    expect(() => parseClamdVersion('')).toThrow(ClamAvProtocolError);
  });
});

describe('signature age signal', () => {
  const version = parseClamdVersion(versionReply);

  it('does not page at or under 48 hours', () => {
    const current = signatureAgeSignal(
      version,
      new Date(builtAt.getTime() + 47 * HOUR_MS),
    );
    const exact = signatureAgeSignal(version, new Date(builtAt.getTime() + 48 * HOUR_MS));
    expect(current).toMatchObject({ signal: 'clamav_signature_age', alert: false });
    expect(exact.alert).toBe(false);
    expect(exact.ageHours).toBe(48);
  });

  it('pages when the database is older than 48 hours', () => {
    const stale = signatureAgeSignal(
      version,
      new Date(builtAt.getTime() + 48 * HOUR_MS + 60_000),
    );
    expect(stale.alert).toBe(true);
    expect(stale.ageHours).toBeGreaterThan(48);
    expect(stale.databaseVersion).toBe(27721);
    expect(stale.databaseBuiltAt).toBe(builtAt.toISOString());
  });

  it('treats a scanner clock behind the database as fresh', () => {
    const skew = signatureAgeSignal(version, new Date(builtAt.getTime() - HOUR_MS));
    expect(skew).toMatchObject({ alert: false, ageHours: 0 });
  });

  it('uses the same 48 hour threshold as the operational alarm', () => {
    const alerts = readFileSync('infra/aws/operational-alerts.example.yaml', 'utf8');
    const hours = CLAMAV_SIGNATURE_STALE_AFTER_MS / HOUR_MS;
    expect(hours).toBe(48);
    expect(alerts).toContain('MetricName: ClamAvSignatureAgeHours');
    expect(alerts).toContain("MetricValue: '$.ageHours'");
    expect(alerts).toContain(`Threshold: ${hours}`);
    expect(alerts).toContain('ComparisonOperator: GreaterThanThreshold');
    expect(alerts).toContain('AlarmName: blakpath-clamav-signature-age');
  });
});

describe('signature age monitor wiring', () => {
  it('starts and stops with the worker process', () => {
    const workerIndex = readFileSync('worker/index.ts', 'utf8');
    expect(workerIndex).toContain('startSignatureAgeMonitor');
    expect(workerIndex).toContain('stopSignatureAgeMonitor');
  });
});
