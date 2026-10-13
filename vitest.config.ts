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
      // Unit-only line coverage is about 33% because `all` counts untested
      // App Router pages and route handlers. 60% stays the long-term target.
      // The global floor is the highest integer the current suite clears.
      thresholds: {
        lines: 32,
        'src/lib/auth/**': { lines: 85 },
        'src/lib/tenancy/**': { lines: 85 },
        'src/lib/permissions/**': { lines: 85 },
      },
    },
  },
});
