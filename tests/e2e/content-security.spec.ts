import { expect, test } from './helpers/page';

function nonceOf(policy: string | undefined): string | undefined {
  return policy?.match(/'nonce-([^']+)'/)?.[1];
}

test('HTML responses carry a fresh content security policy', async ({ page }) => {
  const first = await page.goto('/');
  expect(first?.headers()['content-type']).toContain('text/html');
  const firstPolicy = first?.headers()['content-security-policy'];
  const firstNonce = nonceOf(firstPolicy);
  expect(firstNonce).toBeTruthy();
  expect(firstPolicy).toContain("default-src 'self'");
  expect(firstPolicy).toContain(`'nonce-${firstNonce}'`);
  expect(firstPolicy).toContain("'strict-dynamic'");
  expect(firstPolicy).toContain("object-src 'none'");
  expect(firstPolicy).toContain("base-uri 'none'");
  expect(firstPolicy).toContain("frame-ancestors 'none'");
  expect(firstPolicy).toContain("form-action 'self'");
  expect(firstPolicy).toContain('report-uri /api/csp-report');

  const second = await page.reload();
  const secondNonce = nonceOf(second?.headers()['content-security-policy']);
  expect(secondNonce).toBeTruthy();
  expect(secondNonce).not.toBe(firstNonce);
});

test('cookie API mutations reject a foreign origin and a non-JSON body', async ({
  page,
  request,
}) => {
  await page.goto('/');

  const crossOrigin = await request.post('/api/keys', {
    data: { name: 'foreign' },
    headers: { Origin: 'https://sibling.yumait.au' },
  });
  expect(crossOrigin.status()).toBe(403);
  await expect(crossOrigin.json()).resolves.toEqual({ error: 'Forbidden' });

  const plain = await page.evaluate(async () => {
    const response = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"name":"plain"}',
    });
    return response.status;
  });
  expect(plain).toBe(403);
});
