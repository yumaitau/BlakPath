import { ENCRYPTED_COLUMNS } from './inventory';

/**
 * Raw SQL that counts rows whose inventoried column is still not a version-2
 * tenant envelope. Null is not residue. One row per column, `residue` is the
 * count. A finished backfill leaves every count at 0.
 */
const ORGANISATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function plaintextResidueSql(organisationId?: string): string {
  const org =
    organisationId === undefined
      ? ''
      : (() => {
          if (!ORGANISATION_ID.test(organisationId)) {
            throw new Error('organisation id is not a UUID');
          }
          return ` and organisation_id = '${organisationId}'`;
        })();
  const selects = ENCRYPTED_COLUMNS.map(({ table, column, kind }) => {
    const label = `${table}.${column}`;
    if (kind === 'jsonb') {
      return `select '${label}' as column_name, count(*)::int as residue from ${table} where ${column} is not null and not (jsonb_typeof(${column}) = 'object' and ${column}->>'v' = '2' and coalesce(${column}->>'ciphertext', '') <> '' and coalesce(${column}->>'wrappedDek', '') <> '' and coalesce(${column}->>'kid', '') <> '')${org}`;
    }
    return `select '${label}' as column_name, count(*)::int as residue from ${table} where ${column} is not null and not (left(${column}, 6) = '{"v":2' and position('"ciphertext":' in ${column}) > 0 and position('"wrappedDek":' in ${column}) > 0 and position('"kid":' in ${column}) > 0)${org}`;
  });
  return selects.join('\nunion all\n');
}

export const PLAINTEXT_RESIDUE_SQL = plaintextResidueSql();
