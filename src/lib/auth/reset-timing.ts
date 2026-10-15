/**
 * Floor for password-reset HTTP responses.
 *
 * Unknown addresses never reach the mailer. Known addresses enqueue and
 * return. Padding both paths up to this budget removes the remaining gap
 * when the work finishes early. Work that already exceeded the budget is
 * not delayed further.
 */

export const RESET_RESPONSE_BUDGET_MS = 350;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withConstantTime<T>(
  budgetMs: number,
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  try {
    return await run();
  } finally {
    const remaining = budgetMs - (now() - start);
    if (remaining > 0) await sleep(remaining);
  }
}
