import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  databaseSslMode,
  MIGRATION_TIMEOUTS,
  postgresClientOptions,
  postgresSsl,
  RDS_CA_BUNDLE_PATH,
  readRdsCaBundle,
  SESSION_TIMEOUTS,
} from '@/db/postgres-options';

/** SHA-256 of https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem */
const RDS_CA_SHA256 = 'fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c';

function selfSignedCert(): { cert: string; key: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'blakpath-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=db.invalid',
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8'), dir };
}

/** Speaks just enough of the Postgres SSLRequest handshake to reach TLS. */
function listenTls(
  cert: string,
  key: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const secureContext = tls.createSecureContext({ cert, key });
  const server: Server = createServer((socket) => {
    socket.once('data', () => {
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
      // Should a client ever finish the handshake, drop it so the query fails
      // instead of waiting for Postgres.
      secure.on('secure', () => {
        secure.destroy();
      });
      secure.on('error', () => {
        secure.destroy();
      });
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('TLS fixture did not bind a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

describe('postgres connection options', () => {
  const fixtures: string[] = [];

  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  it('pins the baked RDS global bundle', () => {
    const pem = readFileSync(RDS_CA_BUNDLE_PATH);
    const hash = createHash('sha256').update(pem).digest('hex');
    expect(hash).toBe(RDS_CA_SHA256);
    expect(pem.toString('utf8')).toContain('BEGIN CERTIFICATE');
    expect(readRdsCaBundle()).toContain('BEGIN CERTIFICATE');
  });

  it('verifies the server certificate even when sslmode is require', () => {
    const url = 'postgres://app:secret@db.internal/blakpath?sslmode=require';
    const ssl = postgresSsl(url);
    expect(databaseSslMode(url)).toBe('require');
    expect(ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.internal',
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
    });

    const verified = postgresClientOptions({
      role: 'web',
      poolMax: 1,
      databaseUrl: 'postgres://app:secret@db.internal/blakpath?sslmode=verify-full',
    });
    expect(verified.prepare).toBe(false);
    expect(verified.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.internal',
    });
    expect(verified.connection).toMatchObject(SESSION_TIMEOUTS);
    expect(verified.connection?.statement_timeout).toBeGreaterThan(0);

    const migration = postgresClientOptions({
      role: 'migrate',
      poolMax: 1,
      databaseUrl: 'postgres://app:secret@db.internal/blakpath?sslmode=verify-full',
    });
    expect(migration.max).toBe(1);
    expect(migration.connection).toMatchObject(MIGRATION_TIMEOUTS);
    expect(postgresSsl('postgres://app:secret@localhost/blakpath')).toBe(false);
  });

  it('always verifies the RDS bundle and hostname for every TLS sslmode', () => {
    const ca = readRdsCaBundle();
    for (const sslmode of ['require', 'verify-ca', 'verify-full', 'VERIFY-FULL']) {
      for (const role of ['web', 'worker', 'migrate'] as const) {
        const databaseUrl = `postgres://app:secret@db.internal/blakpath?sslmode=${sslmode}`;
        const { ssl } = postgresClientOptions({ role, poolMax: 1, databaseUrl });
        expect(ssl).toEqual({ ca, rejectUnauthorized: true, servername: 'db.internal' });
        // No override: Node's default checkServerIdentity matches the hostname.
        expect(ssl).not.toHaveProperty('checkServerIdentity');
      }
    }
  });

  it('refuses sslmodes that would skip verification', () => {
    for (const sslmode of ['prefer', 'allow', 'no-verify']) {
      expect(() =>
        postgresSsl(`postgres://app:secret@db.internal/blakpath?sslmode=${sslmode}`),
      ).toThrow(/verify-full/);
    }
  });

  it('refuses a server certificate that is not in the RDS bundle', async () => {
    const generated = selfSignedCert();
    fixtures.push(generated.dir);
    const listener = await listenTls(generated.cert, generated.key);
    const databaseUrl = `postgres://blakpath:blakpath@127.0.0.1:${listener.port}/blakpath?sslmode=verify-full`;
    const verified = postgres(databaseUrl, {
      ...postgresClientOptions({ role: 'web', poolMax: 1, databaseUrl }),
      connect_timeout: 2,
    });

    try {
      await expect(verified`select 1`).rejects.toMatchObject({
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    } finally {
      await verified.end({ timeout: 1 }).catch(() => undefined);
      await listener.close();
    }
  }, 10_000);
});
