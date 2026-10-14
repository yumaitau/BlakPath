import { test as base, expect } from '@playwright/test';

/**
 * Fail a browser test when the document reports a Content-Security-Policy
 * violation. Playwright's own init script is injected outside the page CSP.
 */
export const test = base.extend({
  page: async ({ page }, run) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('CSP_VIOLATION ')) violations.push(text);
    });
    await page.addInitScript(() => {
      addEventListener('securitypolicyviolation', (event) => {
        const sample = event.sample ? ` sample=${event.sample.slice(0, 80)}` : '';
        console.error(
          `CSP_VIOLATION ${event.violatedDirective} blocked=${event.blockedURI}${sample}`,
        );
      });
    });
    await run(page);
    expect(violations, violations.join('\n')).toEqual([]);
  },
});

export { expect };
