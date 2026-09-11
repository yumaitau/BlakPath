/**
 * Schema barrel.
 *
 * `src/db/client.ts` does `import * as schema from './schema'`, so EVERY table,
 * enum and relation must be re-exported here. Keep this file exhaustive — a
 * table that is not re-exported is invisible to the Drizzle query builder and
 * to migration generation.
 */
export * from './enums';
export * from './auth';
export * from './tenancy';
export * from './membership';
export * from './teams';
export * from './calendar';
export * from './applications';
export * from './evidence';
export * from './reviews';
export * from './family';
export * from './meetings';
export * from './decisions';
export * from './certificates';
export * from './tasks';
export * from './forms';
export * from './api-keys';
export * from './webhooks';
export * from './exports';
export * from './retention';
export * from './notifications';
export * from './preferences';
export * from './audit';
