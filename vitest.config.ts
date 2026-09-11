import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    setupFiles: ['./tests/unit/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@worker': fileURLToPath(new URL('./worker', import.meta.url)),
    },
  },
});
