import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_PATH,
  parseSignInReason,
  safeReturnTo,
  selectOrganisationPath,
  signInPath,
} from '@/lib/auth/return-to';

describe('safeReturnTo', () => {
  it('keeps same-origin application paths with their query', () => {
    expect(safeReturnTo('/applications')).toBe('/applications');
    expect(safeReturnTo('/applications/0192f3a4-0000-7000-8000-000000000001')).toBe(
      '/applications/0192f3a4-0000-7000-8000-000000000001',
    );
    expect(safeReturnTo('/meetings?view=week')).toBe('/meetings?view=week');
    expect(safeReturnTo('/join/abcdefghijklmnopqrstuvwxyz')).toBe(
      '/join/abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('drops the fragment and normalises dot segments', () => {
    expect(safeReturnTo('/board#column')).toBe('/board');
    expect(safeReturnTo('/forms/../clients')).toBe('/clients');
  });

  it.each([
    null,
    undefined,
    '',
    'dashboard',
    'https://evil.example/dashboard',
    '//evil.example/dashboard',
    '/\\evil.example',
    '/\\/evil.example',
    '/ok\\..\\evil',
    'javascript:alert(1)',
    '/dash\nboard',
    '/dash board',
    `/${'a'.repeat(600)}`,
  ])('rejects unsafe value %j', (value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_PATH);
  });

  it.each([
    '/api/applications',
    '/sign-in',
    '/sign-in/two-factor',
    '/sign-up',
    '/reset-password?token=x',
    '/_next/static/chunk.js',
    '/forms/../api/keys',
    '/select-organisation?returnTo=%2Fboard',
  ])('refuses API, internal and auth routes as destinations: %s', (value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_PATH);
  });

  it('honours a custom fallback', () => {
    expect(safeReturnTo('//evil.example', '')).toBe('');
  });
});

describe('signInPath', () => {
  it('carries a safe return path and reason', () => {
    expect(signInPath('/applications?status=open', 'expired')).toBe(
      '/sign-in?returnTo=%2Fapplications%3Fstatus%3Dopen&reason=expired',
    );
    expect(signInPath('/board', 'idle')).toBe('/sign-in?returnTo=%2Fboard&reason=idle');
  });

  it('drops unsafe or missing return paths', () => {
    expect(signInPath('https://evil.example')).toBe('/sign-in');
    expect(signInPath(null, 'expired')).toBe('/sign-in?reason=expired');
    expect(signInPath()).toBe('/sign-in');
  });
});

describe('selectOrganisationPath', () => {
  it('continues to a safe return path after choosing an organisation', () => {
    expect(selectOrganisationPath('/applications/abc')).toBe(
      '/select-organisation?returnTo=%2Fapplications%2Fabc',
    );
    expect(selectOrganisationPath('//evil.example')).toBe('/select-organisation');
    expect(selectOrganisationPath(null)).toBe('/select-organisation');
  });
});

describe('parseSignInReason', () => {
  it('accepts only known reasons', () => {
    expect(parseSignInReason('expired')).toBe('expired');
    expect(parseSignInReason('idle')).toBe('idle');
    expect(parseSignInReason('<script>')).toBeNull();
    expect(parseSignInReason(null)).toBeNull();
  });
});
