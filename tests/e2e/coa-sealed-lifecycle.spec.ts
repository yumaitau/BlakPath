import { expect, test } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';

/**
 * Full Confirmation of Aboriginality lifecycle through to a KMS-sealed
 * certificate: intake → review → committee transitions → human decision
 * (propose/vote/finalise) → generate → sign → public verify shows valid
 * with a verified digital seal. Asserts the software never determines —
 * every outcome comes from explicit human-recorded API calls.
 */
test('coa sealed lifecycle: decide, sign, publicly verify', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await signInAndSelectOrganisation(page);
  const api = page.request;
  const stamp = Date.now();

  const app = (await (
    await api.post('/api/applications', {
      data: { applicantName: `Sealed lifecycle applicant ${stamp}` },
    })
  ).json()) as { application: { id: string } };
  const applicationId = app.application.id;

  async function transition(action: string, expected: number): Promise<void> {
    const res = await api.patch(`/api/applications/${applicationId}`, {
      data: { operation: 'transition', action },
    });
    expect(res.status()).toBe(expected);
  }

  await transition('submit', 200);
  await transition('begin_intake', 200);
  await transition('start_review', 200);

  const review = (await (
    await api.post(`/api/applications/${applicationId}/reviews`, {
      data: { content: 'Human reviewer observations for the committee.' },
    })
  ).json()) as { review: { id: string } };
  const finaliseReview = await api.patch(`/api/reviews/${review.review.id}`, {
    data: { operation: 'finalise' },
  });
  expect(finaliseReview.status()).toBe(200);
  await transition('ready_for_committee', 200);
  await transition('schedule_committee', 200);

  const decision = (await (
    await api.post(`/api/applications/${applicationId}/decisions`, {
      data: { outcome: 'confirmed', rationale: 'Committee satisfied on the evidence.' },
    })
  ).json()) as { decision: { id: string } };
  const decisionId = decision.decision.id;
  const vote = await api.patch(`/api/decisions/${decisionId}`, {
    data: { operation: 'vote', choice: 'for' },
  });
  expect(vote.status()).toBe(200);
  const finalise = await api.patch(`/api/decisions/${decisionId}`, {
    data: { operation: 'finalise', outcome: 'confirmed' },
  });
  expect(finalise.status()).toBe(200);
  // Finalising drives record_decision internally; the matter is now decided.

  const cert = (await (
    await api.post('/api/certificates', {
      data: { decisionId },
    })
  ).json()) as { id: string };
  const sign = await api.post(`/api/certificates/${cert.id}/sign`);
  expect(sign.status()).toBe(200);

  const { items } = (await api
    .get(`/api/certificates?applicationId=${applicationId}`)
    .then((r) => r.json())) as {
    items: { verificationCode: string; signature: string; signingKeyId: string }[];
  };
  const sealed = items.find((c) => c.signature);
  expect(sealed, 'signed certificate carries a KMS seal').toBeDefined();

  await page.goto(`/verify/${sealed!.verificationCode}`);
  await expect(page.getByRole('heading', { name: 'Valid certificate' })).toBeVisible();
  await expect(
    page.getByText('Verified — sealed by the issuing organisation'),
  ).toBeVisible();
  await expectNoWcagViolations(page);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
