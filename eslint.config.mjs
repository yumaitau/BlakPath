import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config. eslint-config-next 16 ships native flat-config arrays
 * (`./core-web-vitals`, `./typescript`), so they are spread directly — using
 * FlatCompat here triggers a circular-structure crash in the config validator.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/db/migrations/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      // Read configuration from src/lib/env.ts, never process.env directly.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/lib/env.ts, not process.env.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Infrastructure entrypoints legitimately read process.env directly
    // (they run before / outside the validated env is available).
    files: [
      'src/lib/env.ts',
      'src/db/migrate.ts',
      'drizzle.config.ts',
      'src/instrumentation.ts',
      'tests/**',
      'infra/aws/synthetics/**',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // The canary is inlined CommonJS for the CloudWatch Synthetics runtime.
    files: ['infra/aws/synthetics/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];

export default config;
