/* eslint-disable no-restricted-properties -- Playwright config runs before app env loading. */
import { defineConfig, devices } from '@playwright/test';

/**
 * EKS live config. No local webServer — targets the deployed stack directly
 * (LIVE_BASE_URL, e.g. https://blakpath.yumait.au). Pilot credentials come
 * from PILOT_EMAIL / PILOT_PASSWORD.
 */
export default defineConfig({
  testDir: '.',
  testMatch: process.env.LIVE_TEST_MATCH ?? 'eks-pilot.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.LIVE_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
