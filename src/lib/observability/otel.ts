import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { env } from '@/lib/env';
import { httpObservationFromSpan, scrubSpanAttributes, type SpanLike } from './http-red';
import { logger } from './logger';
import { recordHttpObservation, registerLatencyGauges } from './metrics';
import { scrubErrorForLog } from './scrub';

/**
 * OpenTelemetry tracing bootstrap.
 *
 * Tracing is OPERATIONAL only. Spans and their attributes must never carry
 * applicant data — instrument with opaque ids (organisationId, correlationId)
 * exclusively. If no OTLP endpoint is configured the SDK is a no-op so local
 * and test runs incur zero telemetry overhead.
 */

let sdk: NodeSDK | null = null;
let started = false;

/**
 * Record RED from server spans, then drop URL queries, cookies and SQL text
 * so exported traces cannot carry presigned secrets or applicant content.
 */
const redactAndRecord: SpanProcessor = {
  onStart() {},
  onEnd(span: ReadableSpan) {
    try {
      const observation = httpObservationFromSpan(span as SpanLike);
      if (observation) recordHttpObservation(observation);
      scrubSpanAttributes(span as { attributes: Record<string, unknown> });
    } catch (err) {
      logger.error({ err: scrubErrorForLog(err) }, 'OpenTelemetry span processor failed');
    }
  },
  shutdown() {
    return Promise.resolve();
  },
  forceFlush() {
    return Promise.resolve();
  },
};

function otlpUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  return `${endpoint.replace(/\/$/, '')}/v1/${signal}`;
}

/**
 * Start the tracing SDK once. Safe to call multiple times; subsequent calls are
 * ignored. No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
 */
export async function start(): Promise<void> {
  if (started) return;
  started = true;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.debug('OpenTelemetry disabled: no OTLP endpoint configured');
    return;
  }

  const traceExporter = new OTLPTraceExporter({ url: otlpUrl(endpoint, 'traces') });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: otlpUrl(endpoint, 'metrics'),
      // CloudWatch stores deltas. Cumulative counters would look like an
      // ever-rising total and break the 5xx alarm.
      temporalityPreference: AggregationTemporalityPreference.DELTA,
    }),
    exportIntervalMillis: 60_000,
  });

  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    spanProcessors: [redactAndRecord, new BatchSpanProcessor(traceExporter)],
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are noisy and can leak local paths; disable them.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    registerLatencyGauges();
    logger.info({ endpoint }, 'OpenTelemetry tracing started');
  } catch (err) {
    // Telemetry must never take the application down.
    logger.error({ err }, 'Failed to start OpenTelemetry; continuing without tracing');
    sdk = null;
  }
}

/** True after a successful SDK start. False when no endpoint is configured. */
export function telemetryActive(): boolean {
  return sdk !== null;
}

/** Flush and shut down the tracing SDK. Safe to call when never started. */
export async function shutdown(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    logger.info('OpenTelemetry tracing shut down');
  } catch (err) {
    logger.error({ err }, 'Error shutting down OpenTelemetry');
  } finally {
    sdk = null;
    started = false;
  }
}
