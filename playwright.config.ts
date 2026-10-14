/* eslint-disable no-restricted-properties -- Playwright config runs before app env loading. */
import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN_VERIFY_SECRET } from './tests/e2e/helpers/origin-verify';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

function webServerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.ORIGIN_VERIFY_SECRET = E2E_ORIGIN_VERIFY_SECRET;
  return env;
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    // APIRequestContext does not send Origin. Browser fetch() does. Cookie
    // mutations require the application origin.
    extraHTTPHeaders: {
      Origin: baseURL,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: webServerEnv(),
  },
});
