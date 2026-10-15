import { ClamAvProtocolError } from '@/lib/scanning/clamav';

/**
 * ClamAV `VERSION` replies look like:
 *   ClamAV 1.4.3/27721/Wed Oct 14 08:34:55 2026
 * The third field is the daily database build time, in UTC, without a zone suffix.
 */

/** Page when the loaded daily database is older than this. */
export const CLAMAV_SIGNATURE_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface ClamdDatabaseVersion {
  readonly version: string;
  readonly databaseVersion: number;
  readonly databaseBuiltAt: Date;
}

export interface SignatureAgeSignal {
  readonly signal: 'clamav_signature_age';
  readonly alert: boolean;
  /** Hours since the database was built. Zero when the scanner clock is behind. */
  readonly ageHours: number;
  readonly databaseVersion: number;
  readonly databaseBuiltAt: string;
}

const VERSION_RE =
  /^ClamAV\s+(\S+)\/(\d+)\/([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/;

/** Parse a clamd `VERSION` reply. Throws on anything that is not a database timestamp. */
export function parseClamdVersion(raw: string): ClamdDatabaseVersion {
  const reply = raw.replace(/\0/g, '').trim();
  const match = VERSION_RE.exec(reply);
  const version = match?.[1];
  const databaseVersion = match?.[2];
  const builtAtText = match?.[3];
  if (!version || !databaseVersion || !builtAtText) {
    throw new ClamAvProtocolError(`Unrecognised clamd VERSION reply: ${reply}`);
  }
  const databaseBuiltAt = new Date(`${builtAtText} UTC`);
  if (Number.isNaN(databaseBuiltAt.getTime())) {
    throw new ClamAvProtocolError(`Unrecognised clamd database time: ${builtAtText}`);
  }
  return {
    version,
    databaseVersion: Number(databaseVersion),
    databaseBuiltAt,
  };
}

/**
 * Signature-age signal for the operational log metric.
 * `alert` is true only when the database is strictly older than 48 hours.
 */
export function signatureAgeSignal(
  version: ClamdDatabaseVersion,
  now: Date,
  staleAfterMs = CLAMAV_SIGNATURE_STALE_AFTER_MS,
): SignatureAgeSignal {
  const ageMs = Math.max(0, now.getTime() - version.databaseBuiltAt.getTime());
  const ageHours = Math.round((ageMs / 3_600_000) * 1000) / 1000;
  return {
    signal: 'clamav_signature_age',
    alert: ageMs > staleAfterMs,
    ageHours,
    databaseVersion: version.databaseVersion,
    databaseBuiltAt: version.databaseBuiltAt.toISOString(),
  };
}
