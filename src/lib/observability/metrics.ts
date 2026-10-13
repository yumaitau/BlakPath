import {
  metrics,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from '@opentelemetry/api';
import { percentileOf, pruneSamples, type TimedSample } from './percentile';

/**
 * Operational meters. Names are the CloudWatch metric names exported by the
 * ADOT collector (`infra/otel/collector-eks.yaml`). Attributes stay
 * low-cardinality: queue name and pool name only. No route values, no tenant
 * ids, no personal data.
 *
 * Instruments are created on first use so they bind to the provider installed
 * by `start()`, not the default no-op provider.
 */

const httpSamples: TimedSample[] = [];
const scanSamples: TimedSample[] = [];

let httpRequests: Counter | null = null;
let httpErrors: Counter | null = null;
let httpDuration: Histogram | null = null;
let httpP95: ObservableGauge | null = null;
let scanDuration: Histogram | null = null;
let scanP95: ObservableGauge | null = null;
let appErrors: Counter | null = null;
let callbacksRegistered = false;

function meter() {
  return metrics.getMeter('blakpath');
}

function instruments() {
  if (!httpRequests) {
    const m = meter();
    httpRequests = m.createCounter('http.server.requests', {
      description: 'HTTP responses, excluding load-balancer probes',
    });
    httpErrors = m.createCounter('http.server.errors', {
      description: 'HTTP 5xx responses, excluding load-balancer probes',
    });
    httpDuration = m.createHistogram('http.server.duration', {
      description: 'HTTP server duration',
      unit: 'ms',
    });
    httpP95 = m.createObservableGauge('http.server.duration_p95_ms', {
      description: 'In-process HTTP p95 over the last 5 minutes',
      unit: 'ms',
    });
    scanDuration = m.createHistogram('scan.duration', {
      description: 'Malware-scan job duration',
      unit: 'ms',
    });
    scanP95 = m.createObservableGauge('scan.duration_p95_ms', {
      description: 'In-process malware-scan p95 over the last 5 minutes',
      unit: 'ms',
    });
    appErrors = m.createCounter('app.errors', {
      description: 'Scrubbed operational exceptions',
    });
  }
  return {
    httpRequests: httpRequests!,
    httpErrors: httpErrors!,
    httpDuration: httpDuration!,
    httpP95: httpP95!,
    scanDuration: scanDuration!,
    scanP95: scanP95!,
    appErrors: appErrors!,
  };
}

/** Register p95 gauges once the SDK meter provider is installed. */
export function registerLatencyGauges(): void {
  if (callbacksRegistered) return;
  callbacksRegistered = true;
  const current = instruments();
  meter().addBatchObservableCallback(
    (result) => {
      pruneSamples(httpSamples, Date.now());
      if (httpSamples.length === 0) return;
      result.observe(current.httpP95, percentileOf(httpSamples, 95));
    },
    [current.httpP95],
  );
  meter().addBatchObservableCallback(
    (result) => {
      pruneSamples(scanSamples, Date.now());
      if (scanSamples.length === 0) return;
      result.observe(current.scanP95, percentileOf(scanSamples, 95));
    },
    [current.scanP95],
  );
}

export interface HttpObservation {
  status: number;
  durationMs: number;
}

/** Record one non-probe HTTP response. Status 0 still counts as a request. */
export function recordHttpObservation(
  observation: HttpObservation,
  nowMs = Date.now(),
): void {
  const current = instruments();
  current.httpRequests.add(1);
  if (observation.status >= 500 && observation.status <= 599) current.httpErrors.add(1);
  if (observation.durationMs >= 0) {
    current.httpDuration.record(observation.durationMs);
    httpSamples.push({ atMs: nowMs, value: observation.durationMs });
    pruneSamples(httpSamples, nowMs);
  }
}

/** Record one malware-scan job duration, success or failure. */
export function recordScanDuration(durationMs: number, nowMs = Date.now()): void {
  if (durationMs < 0) return;
  instruments().scanDuration.record(durationMs);
  scanSamples.push({ atMs: nowMs, value: durationMs });
  pruneSamples(scanSamples, nowMs);
}

/** Count one scrubbed exception. The log line is the durable record. */
export function recordCapturedError(): void {
  instruments().appErrors.add(1);
}

export function currentHttpP95(nowMs = Date.now()): number {
  pruneSamples(httpSamples, nowMs);
  return percentileOf(httpSamples, 95);
}

export function currentScanP95(nowMs = Date.now()): number {
  pruneSamples(scanSamples, nowMs);
  return percentileOf(scanSamples, 95);
}

/** Test-only. Production windows live for the process. */
export function __resetMetricWindows(): void {
  httpSamples.length = 0;
  scanSamples.length = 0;
}

export interface QueueGaugeInstruments {
  depth: ObservableGauge;
  oldestAge: ObservableGauge;
  failed: ObservableGauge;
  quarantineBacklog: ObservableGauge;
  quarantineOldestAge: ObservableGauge;
  signatureAge: ObservableGauge;
  poolOpen: ObservableGauge;
  poolMax: ObservableGauge;
}

/** Gauges published by the worker. Created after the SDK has started. */
export function createQueueGauges(): QueueGaugeInstruments {
  const m = meter();
  return {
    depth: m.createObservableGauge('queue.depth', {
      description: 'Waiting, delayed, paused and prioritized jobs',
    }),
    oldestAge: m.createObservableGauge('queue.oldest_age_seconds', {
      description: 'Age of the oldest job not yet active',
      unit: 's',
    }),
    failed: m.createObservableGauge('queue.failed', {
      description: 'Retained failed jobs',
    }),
    quarantineBacklog: m.createObservableGauge('quarantine.backlog', {
      description: 'Evidence rows still pending or quarantined',
    }),
    quarantineOldestAge: m.createObservableGauge('quarantine.oldest_age_seconds', {
      description: 'Age of the oldest unscanned evidence row',
      unit: 's',
    }),
    signatureAge: m.createObservableGauge('clamav.signature_age_seconds', {
      description: 'Age of the ClamAV signature database',
      unit: 's',
    }),
    poolOpen: m.createObservableGauge('db.pool.open', {
      description: 'Open Postgres connections for an application name',
    }),
    poolMax: m.createObservableGauge('db.pool.max', {
      description: 'Configured per-process Postgres pool ceiling',
    }),
  };
}
