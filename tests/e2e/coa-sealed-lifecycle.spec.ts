import { expect, test } from '@playwright/test';
import { expectNoWcagViolations } from './helpers/accessibility';
import { signInAndSelectOrganisation } from './helpers/auth';
import { expectNoPageErrors, watchForPageErrors } from './helpers/page-errors';

/**
 * Full Confirmation of Aboriginality lifecycle through to a sealed certificate:
 * intake → review → human decision (propose/vote/finalise) → generate → sign →
 * download → public verify. Every outcome is an explicit human-recorded call.
 * Committee agenda editing has no HTTP route; meetings stay in calendar-journeys.
 */
test('coa sealed lifecycle: decide, sign, publicly verify', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors = watchForPageErrors(page);
  await signInAndSelectOrganisation(page);
  const api = page.request;
  const stamp = Date.now();
  let applicationId = '';
  let decisionId = '';
  let certificateId = '';
  let verificationCode = '';

  await test.step('application intake', async () => {
    const created = await api.post('/api/applications', {
      data: { applicantName: `Sealed lifecycle applicant ${stamp}` },
    });
    expect(created.status()).toBe(201);
    applicationId = ((await created.json()) as { application: { id: string } })
      .application.id;

    for (const action of ['submit', 'begin_intake', 'start_review'] as const) {
      const res = await api.patch(`/api/applications/${applicationId}`, {
        data: { operation: 'transition', action },
      });
      expect(res.status()).toBe(200);
    }
  });

  await test.step('review create and finalise', async () => {
    const created = await api.post(`/api/applications/${applicationId}/reviews`, {
      data: { content: 'Human reviewer observations for the committee.' },
    });
    expect(created.status()).toBe(201);
    const reviewId = ((await created.json()) as { review: { id: string } }).review.id;
    const finaliseReview = await api.patch(`/api/reviews/${reviewId}`, {
      data: { operation: 'finalise' },
    });
    expect(finaliseReview.status()).toBe(200);
    for (const action of ['ready_for_committee', 'schedule_committee'] as const) {
      const res = await api.patch(`/api/applications/${applicationId}`, {
        data: { operation: 'transition', action },
      });
      expect(res.status()).toBe(200);
    }
  });

  await test.step('decision propose vote and finalise', async () => {
    const proposed = await api.post(`/api/applications/${applicationId}/decisions`, {
      data: { outcome: 'confirmed', rationale: 'Committee satisfied on the evidence.' },
    });
    expect(proposed.status()).toBe(201);
    decisionId = ((await proposed.json()) as { decision: { id: string } }).decision.id;
    const vote = await api.patch(`/api/decisions/${decisionId}`, {
      data: { operation: 'vote', choice: 'for' },
    });
    expect(vote.status()).toBe(200);
    const finalise = await api.patch(`/api/decisions/${decisionId}`, {
      data: { operation: 'finalise', outcome: 'confirmed' },
    });
    expect(finalise.status()).toBe(200);
  });

  await test.step('human outcome is an explicit recorded act', async () => {
    const beforeGenerate = await api.get(
      `/api/certificates?applicationId=${applicationId}`,
    );
    expect(beforeGenerate.status()).toBe(200);
    const beforeBody = (await beforeGenerate.json()) as { items: unknown[] };
    expect(beforeBody.items).toEqual([]);
    await page.goto('/applications');
    await expect(page.getByText(/auto-approve/i)).toHaveCount(0);
    await expect(page.getByText(/identity score/i)).toHaveCount(0);
  });

  await test.step('certificate generate sign and download', async () => {
    const generated = await api.post('/api/certificates', { data: { decisionId } });
    expect(generated.status()).toBe(200);
    certificateId = ((await generated.json()) as { id: string }).id;
    const sign = await api.post(`/api/certificates/${certificateId}/sign`);
    expect(sign.status()).toBe(200);

    const listed = await api.get(`/api/certificates?applicationId=${applicationId}`);
    expect(listed.status()).toBe(200);
    const { items } = (await listed.json()) as {
      items: { verificationCode: string; signature: string | null }[];
    };
    const sealed = items.find((certificate) => certificate.signature);
    expect(sealed, 'signed certificate carries a seal').toBeDefined();
    verificationCode = sealed?.verificationCode ?? '';

    const download = await api.get(`/api/certificates/${certificateId}/download`, {
      maxRedirects: 0,
    });
    expect(download.status()).toBe(307);
  });

  await test.step('public verify', async () => {
    await page.goto(`/verify/${verificationCode}`);
    await expect(page.getByRole('heading', { name: 'Valid certificate' })).toBeVisible();
    await expect(
      page.getByText('Verified — sealed by the issuing organisation'),
    ).toBeVisible();
    await expectNoWcagViolations(page);
  });

  expectNoPageErrors(pageErrors);
});
