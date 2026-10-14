import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * Shared column helpers.
 *
 * Identifiers use UUIDv7: non-sequential and public-safe (no row-count leak),
 * but time-ordered so they index well. Generated in the application layer so
 * the value is known before insert (needed for audit hash-chaining and
 * object-storage keys).
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** A UUIDv7 foreign-key / reference column (nullable by default). */
export const refId = (name: string) => uuid(name);

/**
 * Every tenant-owned table MUST include this column. Isolation is enforced in
 * the data-access layer (see src/db/tenant-db.ts) and, defence-in-depth, by
 * row-level security: ENABLE + FORCE, policy `tenant_isolation`
 * (`src/db/schema/_rls.ts`). A composite index leading with this column is
 * expected on every tenant table.
 */
export const organisationId = () => uuid('organisation_id').notNull();

/** created_at / updated_at present on virtually every table. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Optimistic-concurrency version counter for records that need it. */
export const rowVersion = {
  version: timestamp('version', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
