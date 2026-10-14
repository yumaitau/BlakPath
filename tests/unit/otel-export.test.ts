import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import { shutdown, start } from '@/lib/observability/otel';

/**
 * Guards the OpenTelemetry v2 stack: the SDK bootstrap must export spans to an
 * OTLP/HTTP collector and flush them on shutdown. A local HTTP server stands in
 * for the collector so no network or container is needed.
 */

type Received = { method: string | undefined; url: string | undefined; body: string };

let server: Server;
let received: Received[] = [];
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await shutdown();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  __resetEnvCache();
  received = [];
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('OpenTelemetry bootstrap', () => {
  // Export runs first: `start()` is once-only until a real SDK is shut down.
  it('exports spans to the collector over OTLP/HTTP on shutdown', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${endpoint}/`;
    __resetEnvCache();
    await start();
    trace.getTracer('blakpath-test').startSpan('otel-export-check').end();
    await shutdown();

    const traces = received.filter((r) => r.method === 'POST' && r.url === '/v1/traces');
    expect(traces.length).toBeGreaterThan(0);
    const body = traces.map((r) => r.body).join('');
    expect(body).toContain('otel-export-check');
    expect(body).toContain('blakpath');
  }, 20_000);

  it('is a no-op when no OTLP endpoint is configured', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    __resetEnvCache();
    await start();
    trace.getTracer('blakpath-test').startSpan('noop-span').end();
    await shutdown();
    expect(received).toHaveLength(0);
  });
});
