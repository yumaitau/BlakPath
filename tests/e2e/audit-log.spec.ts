import { expect, test } from './helpers/page';
import { signInAndSelectOrganisation } from './helpers/auth';

test('an organisation administrator reads the audit trail and records the monthly review', async ({
  page,
}) => {
  await signInAndSelectOrganisation(page);

  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

  const exported = await page.request.get('/api/audit/events/export');
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toContain('text/csv');

  await page.goto('/audit/review');
  await expect(page.getByRole('heading', { name: 'Monthly audit review' })).toBeVisible();
  await page.getByRole('button', { name: 'Record this review' }).click();
  await expect(page).toHaveURL(/\/audit\/review\?recorded=1$/);
  await expect(page.getByRole('status')).toContainText('Review recorded');
});
