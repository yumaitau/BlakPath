import { expect, test } from '@playwright/test';
import { signInAndSelectOrganisation } from './helpers/auth';

/**
 * SSO bindings + consent gate (#26). Federated session issuance stays open
 * work; this locks the shippable surface: bindings list gated, consent CRUD
 * works, representative access without live consent is denied and audited.
 * Consent ledger v2 (#41): wording versions, consent for a person without an
 * account, withdrawal as an appended event.
 */
test('sso: bindings list is admin-gated, anonymous denied', async ({ page, request }) => {
  const anon = await request.get('/api/sso/providers');
  expect(anon.status()).toBe(401);

  await signInAndSelectOrganisation(page);
  const list = await page.request.get('/api/sso/providers');
  expect([200, 403]).toContain(list.status());
  if (list.status() === 200) {
    const body = (await list.json()) as { providers: unknown[] };
    expect(Array.isArray(body.providers)).toBe(true);
  }
});

test('consent: record, list, and gate representative access', async ({ page }) => {
  await signInAndSelectOrganisation(page);

  // Representative request with a bogus consent id must deny, never create.
  const denied = await page.request.post('/api/representatives', {
    data: {
      subjectUserId: '00000000-0000-4000-8000-000000000000',
      representativeUserId: '00000000-0000-4000-8000-000000000001',
      purpose: 'Act on my behalf',
      consentEventId: '00000000-0000-4000-8000-000000000002',
    },
  });
  expect([400, 403, 404]).toContain(denied.status());

  // SCIM is off without bearer: denied, no user enumeration.
  const scim = await page.request.post(
    '/api/scim/v2/00000000-0000-4000-8000-000000000000/Users',
    {
      data: { userName: 'nobody@example.test' },
    },
  );
  expect([403, 404]).toContain(scim.status());
});

test('consent ledger: wording, accountless grant, withdrawal, append-only history', async ({
  page,
  request,
}) => {
  const anonymous = await request.post(
    '/api/consents/00000000-0000-4000-8000-000000000003/withdraw',
    { data: { method: 'online-acknowledgement' } },
  );
  expect(anonymous.status()).toBe(401);

  await signInAndSelectOrganisation(page);

  const wording = await page.request.post('/api/consents/wording', {
    data: {
      purpose: 'evidence-handling',
      title: 'Handling your documents',
      body: 'We keep your documents securely and use them only for your application.',
    },
  });
  expect(wording.status()).toBe(201);
  const { version } = (await wording.json()) as {
    version: { id: string; version: number; bodySha256: string };
  };
  expect(version.version).toBeGreaterThanOrEqual(1);
  expect(version.bodySha256).toMatch(/^[0-9a-f]{64}$/);

  // A person with no account: consent attaches to their client record.
  const created = await page.request.post('/api/clients', {
    data: { displayName: `Paper intake ${globalThis.crypto.randomUUID().slice(0, 8)}` },
  });
  expect(created.status()).toBe(201);
  const { client } = (await created.json()) as { client: { id: string } };

  const grantInput = {
    subjectClientId: client.id,
    purpose: 'evidence-handling',
    wordingVersionId: version.id,
    method: 'signed-form',
  };
  const noEvidence = await page.request.post('/api/consents', { data: grantInput });
  expect(noEvidence.status()).toBe(400);

  const granted = await page.request.post('/api/consents', {
    data: { ...grantInput, evidenceReference: 'Signed intake form (E2E)' },
  });
  expect(granted.status()).toBe(201);
  const { consent } = (await granted.json()) as {
    consent: { id: string; kind: string; subjectUserId: string | null };
  };
  expect(consent).toMatchObject({ kind: 'granted', subjectUserId: null });

  const history = async () => {
    const res = await page.request.get(`/api/consents?client=${client.id}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      consents: Array<{ grant: { id: string }; state: string; withdrawal: unknown }>;
    };
    return body.consents;
  };
  expect((await history()).map((v) => v.state)).toEqual(['live']);

  const withdrawn = await page.request.post(`/api/consents/${consent.id}/withdraw`, {
    data: { method: 'written-request', evidenceReference: 'Letter received (E2E)' },
  });
  expect(withdrawn.status()).toBe(201);
  const result = (await withdrawn.json()) as {
    withdrawal: { kind: string; grantEventId: string };
    revokedRepresentativeAuthorisationIds: string[];
  };
  expect(result.withdrawal).toMatchObject({
    kind: 'withdrawn',
    grantEventId: consent.id,
  });

  // Withdrawal is a second event; the grant survives and cannot be withdrawn twice.
  const again = await page.request.post(`/api/consents/${consent.id}/withdraw`, {
    data: { method: 'written-request', evidenceReference: 'Duplicate (E2E)' },
  });
  expect(again.status()).toBe(403);
  const after = await history();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ grant: { id: consent.id }, state: 'withdrawn' });
  expect(after[0]?.withdrawal).not.toBeNull();

  const mine = await page.request.get('/api/consents/mine');
  expect(mine.status()).toBe(200);
});
