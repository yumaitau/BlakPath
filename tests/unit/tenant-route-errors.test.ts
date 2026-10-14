import { describe, expect, it } from 'vitest';
import { toErrorResponse } from '@/lib/http/tenant-route';

describe('toErrorResponse', () => {
  it('maps malformed JSON to 400', async () => {
    let caught: unknown;
    try {
      JSON.parse('{');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyntaxError);
    const response = toErrorResponse(caught);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid request' });
  });

  it('keeps an unexpected failure as 500', async () => {
    const response = toErrorResponse(new Error('boom'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal error' });
  });
});
