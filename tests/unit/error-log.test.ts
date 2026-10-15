import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { logRedaction, logSerializers } from '@/lib/observability/logger';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino(
    { level: 'info', redact: logRedaction, serializers: logSerializers },
    stream,
  );
  return { lines, logger };
}

describe('logged database errors', () => {
  it('logs a forced users.email unique violation without the email', () => {
    const email = 'forced.unique.ada@example.com';
    const detail = `Key (email)=(${email}) already exists.`;
    const cause = new Error(
      `duplicate key value violates unique constraint "users_email_unique"\n${detail}`,
    );
    Object.assign(cause, {
      code: '23505',
      detail,
      table: 'users',
      constraint: 'users_email_unique',
    });
    const error = new DrizzleQueryError(
      'insert into "users" ("id", "name", "email", "email_verified") values ($1, $2, $3, $4)',
      ['user-1', 'Ada Lovelace', email, true],
      cause,
    );
    expect(error.message).toContain(email);
    expect(error.cause).toMatchObject({ detail });

    const { lines, logger } = captureLogger();
    logger.error({ err: error }, 'unhandled route error');
    logger.error({ error }, 'failed to enqueue membership invitation email');

    const serialised = lines.join('\n');
    expect(serialised).toContain('DrizzleQueryError');
    expect(serialised).toContain('23505');
    expect(serialised).toContain('users_email_unique');
    expect(serialised).not.toContain(email);
    expect(serialised).not.toContain('Ada Lovelace');
    expect(serialised).not.toContain('insert into');
    expect(serialised).not.toContain('params');
    expect(serialised).not.toContain('"detail"');
  });

  it('censors an email nested several objects deep', () => {
    const email = 'nested.person@example.com';
    const { lines, logger } = captureLogger();
    logger.info({ profile: { contact: { email } } }, 'nested identifier');
    const serialised = lines.join('\n');
    expect(serialised).toContain('[redacted]');
    expect(serialised).not.toContain(email);
  });
});
