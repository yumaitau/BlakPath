/**
 * Unit-test environment defaults.
 *
 * Some modules under test read validated env at import time (via the logger).
 * CI provides real test values; locally these dummies keep such imports from
 * throwing. They are never real credentials and never leave the test runner.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-value-at-least-32-characters-long';
process.env.ENCRYPTION_MASTER_KEY ??= 'dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtMTIzNDU=';
