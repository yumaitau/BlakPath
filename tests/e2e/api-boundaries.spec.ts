import { expect, test } from './helpers/page';

test('sensitive APIs consistently reject anonymous requests', async ({ request }) => {
  const protectedGets = [
    '/api/applications',
    '/api/tasks',
    '/api/forms',
    '/api/notifications',
    '/api/calendar/meetings',
    '/api/memberships',
    '/api/membership-invitations',
    '/api/reports/exports',
    '/api/keys',
    '/api/webhooks',
    '/api/retention/holds',
    '/api/retention/policies',
    '/api/retention/preview',
  ];

  for (const path of protectedGets) {
    await test.step(`${path} rejects anonymous access`, async () => {
      const response = await request.get(path);
      expect(response.status()).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    });
  }

  const resourceId = '00000000-0000-4000-8000-000000000000';
  const protectedMutations = [
    {
      method: 'post',
      path: '/api/membership-invitations/accept',
      data: { token: 'not-a-real-membership-invitation-token' },
    },
    {
      method: 'post',
      path: `/api/applications/${resourceId}/evidence`,
      data: {
        fileName: 'record.png',
        contentType: 'image/png',
        sizeBytes: 100,
      },
    },
    {
      method: 'post',
      path: `/api/evidence/${resourceId}/complete`,
      data: {},
    },
    {
      method: 'post',
      path: `/api/applications/${resourceId}/reviews`,
      data: { content: 'Human reviewer observations.' },
    },
    {
      method: 'post',
      path: `/api/applications/${resourceId}/decisions`,
      data: { outcome: 'deferred' },
    },
    {
      method: 'patch',
      path: `/api/reviews/${resourceId}`,
      data: { operation: 'finalise' },
    },
    {
      method: 'patch',
      path: `/api/decisions/${resourceId}`,
      data: { operation: 'vote', choice: 'abstain' },
    },
    {
      method: 'post',
      path: `/api/webhooks/${resourceId}/deliveries/${resourceId}/redeliver`,
      data: {},
    },
  ] as const;

  for (const mutation of protectedMutations) {
    await test.step(`${mutation.path} rejects anonymous access`, async () => {
      const response = await request[mutation.method](mutation.path, {
        data: mutation.data,
      });
      expect(response.status()).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    });
  }
});

test('public operational endpoints expose only their intended status', async ({
  request,
}) => {
  const live = await request.get('/api/live');
  expect(live.status()).toBe(200);
  await expect(live.json()).resolves.toMatchObject({ status: 'ok' });

  const externalHealth = await request.get('/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.10', 'cf-connecting-ip': '203.0.113.10' },
  });
  expect(externalHealth.status()).toBe(403);
  await expect(externalHealth.json()).resolves.toEqual({ error: 'Forbidden' });

  // Direct call, same shape as a VPC client that did not traverse the edge.
  const health = await request.get('/api/health');
  expect([200, 503]).toContain(health.status());
  const healthPayload = (await health.json()) as { status: string; checks: object };
  expect(healthPayload.status).toMatch(/^(healthy|degraded)$/);
  expect(healthPayload.checks).toBeTruthy();

  const missingCertificate = await request.get('/verify/not-a-real-certificate');
  expect(missingCertificate.status()).toBe(200);
  expect(await missingCertificate.text()).toContain('Certificate not found');
});
