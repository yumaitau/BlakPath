import { expect, type Page } from '@playwright/test';

/** Collect uncaught page errors so a spec can assert the list stayed empty. */
export function watchForPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

export function expectNoPageErrors(errors: readonly Error[]): void {
  expect(errors.map((error) => error.message)).toEqual([]);
}
