import type { Page } from '@playwright/test';

/** Collect uncaught page errors so a spec can assert none fired. */
export function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}
