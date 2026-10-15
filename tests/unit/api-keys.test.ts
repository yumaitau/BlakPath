import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  displayPrefix,
  hashApiKey,
  looksLikeApiKey,
  parseBearer,
} from '@/domains/api-keys/keys';
import { createApiKeySchema } from '@/domains/api-keys/schemas';

describe('api key primitives', () => {
  it('hashes deterministically and differs per key', () => {
    const a = hashApiKey('bp_secret');
    expect(a).toBe(hashApiKey('bp_secret'));
    expect(a).not.toBe(hashApiKey('bp_other'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a bearer token, ignoring case and whitespace', () => {
    expect(parseBearer('Bearer bp_abc123')).toBe('bp_abc123');
    expect(parseBearer('bearer   bp_abc123  ')).toBe('bp_abc123');
    expect(parseBearer('Basic xyz')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
  });

  it('recognises a plausible key shape and a display prefix', () => {
    const key = `${API_KEY_PREFIX}${'a'.repeat(40)}`;
    expect(looksLikeApiKey(key)).toBe(true);
    expect(looksLikeApiKey('nope')).toBe(false);
    expect(displayPrefix(key)).toBe(`${API_KEY_PREFIX}aaaaaa`);
    expect(displayPrefix(key).length).toBe(API_KEY_PREFIX.length + 6);
  });
});

describe('createApiKeySchema', () => {
  it('requires a name and at least one valid permission scope', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'CI', scopes: ['application:read-any'] })
        .success,
    ).toBe(true);
    expect(
      createApiKeySchema.safeParse({ name: '', scopes: ['application:read-any'] })
        .success,
    ).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'CI', scopes: [] }).success).toBe(false);
  });

  it('rejects scopes that are not catalogue permission keys', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'CI', scopes: ['make:everything'] }).success,
    ).toBe(false);
  });

  it('requires a declared purpose and destination for mcp scopes', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'MCP', scopes: ['mcp:read'] }).success,
    ).toBe(false);
    const parsed = createApiKeySchema.safeParse({
      name: 'MCP',
      scopes: ['mcp:read'],
      purpose: 'Draft neutral status replies',
      destination: 'Council records assistant, ap-southeast-2',
    });
    expect(parsed.success).toBe(true);
    expect(
      createApiKeySchema.safeParse({
        name: 'MCP',
        scopes: ['mcp:read-pii'],
        purpose: 'Named correspondence',
        destination: '',
      }).success,
    ).toBe(false);
  });

  it('defaults and caps expiry', () => {
    expect(
      createApiKeySchema.parse({ name: 'CI', scopes: ['application:read-any'] })
        .expiresInDays,
    ).toBe(365);
    expect(
      createApiKeySchema.safeParse({
        name: 'CI',
        scopes: ['application:read-any'],
        expiresInDays: 9999,
      }).success,
    ).toBe(false);
  });
});
