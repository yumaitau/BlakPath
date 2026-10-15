import { getTableColumns, type Table } from 'drizzle-orm';
import {
  accounts,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from '@/db/schema/auth';
import { createAuthPlugins } from './plugins';

type PluginWithSchema = {
  schema?: Record<string, { fields?: Record<string, unknown> } | undefined>;
};

/**
 * Better Auth model name → Drizzle table. Must stay aligned with the adapter
 * map in `src/lib/auth/index.ts`.
 */
const MODEL_TABLES: Record<string, Table> = {
  user: users,
  account: accounts,
  session: sessions,
  verification: verifications,
  passkey: passkeys,
  twoFactor: twoFactors,
};

export type AuthFieldMap = Record<string, { fields: Record<string, unknown> }>;

/**
 * Field names Better Auth will write that the Drizzle table does not declare.
 * The adapter drops unknown keys, so a gap here is a silently lost write.
 */
export function missingAuthFields(
  expected: AuthFieldMap,
  columnsByModel: Record<string, ReadonlySet<string>>,
): string[] {
  const gaps: string[] = [];
  for (const [model, table] of Object.entries(expected)) {
    const columns = columnsByModel[model];
    if (!columns) {
      gaps.push(`${model}: no Drizzle table`);
      continue;
    }
    for (const field of Object.keys(table.fields)) {
      if (!columns.has(field)) gaps.push(`${model}.${field}`);
    }
  }
  return gaps;
}

function expectedPluginFields(plugins: readonly PluginWithSchema[]): AuthFieldMap {
  const expected: AuthFieldMap = {};
  for (const plugin of plugins) {
    for (const [model, definition] of Object.entries(plugin.schema ?? {})) {
      const current = expected[model]?.fields ?? {};
      expected[model] = { fields: { ...current, ...definition?.fields } };
    }
  }
  return expected;
}

/** Gaps between the enabled Better Auth plugins and the Drizzle auth tables. */
export function findAuthSchemaGaps(): string[] {
  const expected = expectedPluginFields(createAuthPlugins('http://localhost:3000'));
  const columnsByModel: Record<string, ReadonlySet<string>> = {};
  for (const [model, table] of Object.entries(MODEL_TABLES)) {
    columnsByModel[model] = new Set(Object.keys(getTableColumns(table)));
  }
  return missingAuthFields(expected, columnsByModel);
}

/** Refuse to boot or load auth when a plugin field has nowhere to be stored. */
export function assertAuthSchemaCoverage(): void {
  const gaps = findAuthSchemaGaps();
  if (gaps.length > 0) {
    throw new Error(
      `Drizzle auth schema is missing Better Auth fields: ${gaps.join(', ')}`,
    );
  }
}
