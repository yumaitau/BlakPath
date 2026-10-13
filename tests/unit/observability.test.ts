import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { jobSpanAttributes } from '@/lib/observability/job-span';
import {
  httpObservationFromSpan,
  scrubSpanAttributes,
} from '@/lib/observability/http-red';
import {
  __resetMetricWindows,
  currentHttpP95,
  recordHttpObservation,
  recordScanDuration,
  currentScanP95,
} from '@/lib/observability/metrics';
import { percentile, pruneSamples } from '@/lib/observability/percentile';
import { isProbeRoute, normalizeHttpRoute } from '@/lib/observability/route-label';
import { scrubText } from '@/lib/observability/scrub';
import {
  ageSeconds,
  asDate,
  parseClamdVersionDate,
  quarantineOldestAgeSeconds,
  queueDepth,
  signatureAgeSeconds,
} from '@/lib/observability/snapshots';
import {
  AVAILABILITY_SLO_PERCENT,
  CLAMAV_SIGNATURE_AGE_SECONDS,
  DB_POOL_OPEN_ALARM,
  HTTP_5XX_ALARM,
  HTTP_P95_MS,
  LOG_RETENTION_DAYS,
  QUARANTINE_OLDEST_AGE_SECONDS,
  QUEUE_DEPTH_ALARM,
  QUEUE_OLDEST_AGE_SECONDS,
  SCAN_P95_MS,
} from '@/lib/observability/slo';
import { readFileSync } from 'node:fs';

describe('http route labels', () => {
  it('drops query secrets and high-cardinality segments', () => {
    expect(normalizeHttpRoute('/form/abcDEF1234567890abcd?token=secret')).toBe(
      '/form/:token',
    );
    expect(
      normalizeHttpRoute(
        '/api/applications/018f6b3a-7b3e-7c2a-8f1e-9a0b1c2d3e4f/evidence',
      ),
    ).toBe('/api/applications/:id/evidence');
    expect(normalizeHttpRoute('/verify/42')).toBe('/verify/:id');
  });

  it('recognises load-balancer probes', () => {
    expect(isProbeRoute('/api/ready')).toBe(true);
    expect(isProbeRoute('/sign-in')).toBe(false);
  });
});

describe('span redaction and RED', () => {
  it('counts server spans and ignores probes', () => {
    const server = httpObservationFromSpan({
      kind: SpanKind.SERVER,
      attributes: { 'http.route': '/sign-in', 'http.status_code': 500 },
      startTime: [10, 0],
      endTime: [10, 250_000_000],
    });
    expect(server).toEqual({ route: '/sign-in', status: 500, durationMs: 250 });

    expect(
      httpObservationFromSpan({
        kind: SpanKind.SERVER,
        attributes: { 'http.target': '/api/ready?x=1', 'http.status_code': 200 },
        startTime: [1, 0],
        endTime: [1, 0],
      }),
    ).toBeNull();
    expect(
      httpObservationFromSpan({
        kind: SpanKind.CLIENT,
        attributes: { 'http.route': '/sign-in' },
        startTime: [1, 0],
        endTime: [1, 0],
      }),
    ).toBeNull();
  });

  it('removes urls, cookies and sql before export', () => {
    const span = {
      attributes: {
        'http.route': '/join/abcdefghijklmnopqrstuvwxyz',
        'url.full':
          'https://blakpath.example/join/abcdefghijklmnopqrstuvwxyz?X-Amz-Signature=abc',
        'http.request.header.cookie': 'session=secret',
        'db.statement': 'select * from evidence',
      } as Record<string, unknown>,
    };
    scrubSpanAttributes(span);
    expect(span.attributes['http.route']).toBe('/join/:token');
    expect(span.attributes['url.full']).toBeUndefined();
    expect(span.attributes['db.statement']).toBeUndefined();
    expect(span.attributes['http.request.header.cookie']).toBeUndefined();
  });
});

describe('error scrubbing', () => {
  it('strips emails, tokens, jwts and urls from free text', () => {
    const scrubbed = scrubText(
      'user ada@example.org bearer token=abc.def password=hunter2 bp_live_abcdefghij https://files.example/obj?X-Amz-Signature=zzz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    );
    expect(scrubbed).not.toContain('ada@example.org');
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).not.toContain('bp_live_abcdefghij');
    expect(scrubbed).not.toContain('X-Amz-Signature');
    expect(scrubbed).not.toContain('eyJhbGci');
  });
});

describe('latency windows', () => {
  it('computes a nearest-rank p95 and drops old samples', () => {
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    const samples = [
      { atMs: 0, value: 5_000 },
      { atMs: 100_000, value: 10 },
    ];
    pruneSamples(samples, 100_000, 60_000, 10);
    expect(samples).toEqual([{ atMs: 100_000, value: 10 }]);
  });

  it('tracks http and scan p95 in process', () => {
    __resetMetricWindows();
    const now = 1_000_000;
    for (let value = 1; value <= 100; value += 1) {
      recordHttpObservation(
        { status: value === 100 ? 500 : 200, durationMs: value },
        now,
      );
    }
    recordScanDuration(1_000, now);
    recordScanDuration(2_000, now);
    expect(currentHttpP95(now)).toBe(95);
    expect(currentScanP95(now)).toBe(2_000);
    __resetMetricWindows();
  });
});

describe('operational snapshots', () => {
  it('sums backlog and ignores a missing oldest job', () => {
    expect(
      queueDepth({ waiting: 2, delayed: 3, paused: 1, prioritized: 4, failed: 9 }),
    ).toBe(10);
    expect(ageSeconds(null, 5_000)).toBe(0);
    expect(ageSeconds(1_000, 6_000)).toBe(5);
  });

  it('parses a clamd VERSION date and the quarantine age', () => {
    const signedAt = parseClamdVersionDate(
      'ClamAV 1.4.1/27340/Tue Oct 13 00:00:00 2026\0',
    );
    expect(signedAt?.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(parseClamdVersionDate('PONG')).toBeNull();
    expect(signatureAgeSeconds(signedAt!, Date.parse('2026-10-15T00:00:00.000Z'))).toBe(
      2 * 24 * 60 * 60,
    );
    expect(quarantineOldestAgeSeconds(null, 10)).toBe(0);
    expect(quarantineOldestAgeSeconds(new Date(0), 5_000)).toBe(5);
    expect(asDate('2026-10-13T00:00:00.000Z')?.toISOString()).toBe(
      '2026-10-13T00:00:00.000Z',
    );
  });
});

describe('worker span attributes', () => {
  it('keeps opaque ids and drops the rest of the payload', () => {
    const attributes = jobSpanAttributes('malware-scan', {
      name: 'scan',
      data: {
        organisationId: 'org-1',
        correlationId: 'corr-1',
        // Extra payload fields must not be copied onto the span.
        objectKey: 'org-1/evidence/file.pdf',
      } as { organisationId: string; correlationId: string },
    });
    expect(attributes).toEqual({
      'messaging.system': 'bullmq',
      'messaging.destination': 'malware-scan',
      'messaging.operation': 'process',
      'blakpath.job_name': 'scan',
      'blakpath.organisation_id': 'org-1',
      'blakpath.correlation_id': 'corr-1',
    });
    expect(JSON.stringify(attributes)).not.toContain('file.pdf');
  });
});

describe('alarm contract', () => {
  it('keeps CloudFormation thresholds aligned with the SLO constants', () => {
    const template = readFileSync('infra/aws/observability.example.yaml', 'utf8');
    expect(template).toContain(`Default: ${LOG_RETENTION_DAYS}`);
    expect(template).toContain(`Threshold: ${HTTP_5XX_ALARM}`);
    expect(template).toContain(`Threshold: ${QUEUE_DEPTH_ALARM}`);
    expect(template).toContain(`Threshold: ${QUEUE_OLDEST_AGE_SECONDS}`);
    expect(template).toContain(`Threshold: ${QUARANTINE_OLDEST_AGE_SECONDS}`);
    expect(template).toContain(`Threshold: ${CLAMAV_SIGNATURE_AGE_SECONDS}`);
    expect(template).toContain(`Threshold: ${DB_POOL_OPEN_ALARM}`);
    expect(template).toContain(`Threshold: ${HTTP_P95_MS}`);
    expect(template).toContain(`Threshold: ${SCAN_P95_MS}`);
    expect(template).toContain(`Threshold: ${AVAILABILITY_SLO_PERCENT - 0.9}`);
    expect(template).toContain('DatapointsToAlarm: 2');
    expect(template).toContain('CanaryName');

    const canary = readFileSync('infra/aws/synthetics/ready-signin.cjs', 'utf8');
    for (const line of canary.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) expect(template).toContain(trimmed);
    }
  });
});
