/* eslint-disable no-restricted-properties -- Playwright config runs before app env loading. */
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.BLAKPATH_LIVE_WEB_PORT ?? 3018);
const baseURL = process.env.LIVE_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests/live',
  testMatch: process.env.LIVE_TEST_MATCH ?? 'full-stack.spec.ts',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  use: {
    baseURL,
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
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
