import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '@worker': fileURLToPath(new URL('./worker', import.meta.url)),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    // `*.test.tsx` runs in jsdom. Everything else stays on node.
    projects: [
      {
        extends: true,
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'src/**/*.test.ts',
          ],
          exclude: ['tests/e2e/**', 'node_modules/**'],
        },
      },
      {
        extends: true,
        resolve: { alias },
        plugins: [react()],
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx', 'src/**/*.test.tsx'],
          exclude: ['tests/e2e/**', 'node_modules/**'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**', 'worker/**'],
      // Floors, not targets. Raise them when a change lifts coverage; do not
      // lower them to make a shrinking suite pass.
      //
      // Measured with RUN_INTEGRATION=true, as CI runs it: lines 58.5% overall,
      // auth 71.2%, tenancy 90.9%, permissions 96.8%. Each floor sits just
      // under that. Without the integration suite the global figure is far
      // lower, so run coverage against a database. 60% overall and 85% for
      // auth stay the targets; the auth gap is the step-up and SSO plugins.
      thresholds: {
        lines: 57,
        'src/lib/auth/**': { lines: 70 },
        'src/lib/tenancy/**': { lines: 90 },
        'src/lib/permissions/**': { lines: 96 },
      },
    },
  },
});
