import { describe, expect, it } from 'vitest';
import { errorResponse } from '@/lib/http/error-response';

describe('errorResponse (tenant routes)', () => {
  it('maps malformed JSON to 400', async () => {
    let caught: unknown;
    try {
      JSON.parse('{');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyntaxError);
    const response = errorResponse(caught);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid request' });
  });

  it('keeps an unexpected failure as 500', async () => {
    const response = errorResponse(new Error('boom'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'Internal error' });
  });
});
