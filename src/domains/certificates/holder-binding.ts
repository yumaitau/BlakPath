import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Holder binding for a sealed certificate.
 *
 * The signed payload carries salted hashes, never the name or date of birth.
 * A later check only reports whether details a person typed match what
 * authorised humans recorded on the certificate. It does not determine
 * Aboriginality, score identity, or approve or reject anyone.
 */

const DOB_KEYS = ['dateOfBirth', 'date_of_birth'] as const;

export interface HolderBinding {
  salt: string;
  nameHash: string;
  dobHash: string | null;
}

/** Case- and whitespace-insensitive name, stable for the sealed hash. */
export function normalizeHolderName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU');
}

function validIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`;
}

/** Accept ISO `YYYY-MM-DD` or Australian `D/M/YYYY`. Anything else is absent. */
export function normalizeHolderDob(value: string): string | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (au) return validIsoDate(Number(au[3]), Number(au[2]), Number(au[1]));
  return null;
}

/** Pull a date of birth from organisation-defined intake, when one was recorded. */
export function dateOfBirthFromIntake(intake: unknown): string | null {
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) return null;
  const record = intake as Record<string, unknown>;
  for (const key of DOB_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = normalizeHolderDob(value);
    if (normalized) return normalized;
  }
  return null;
}

function saltedHash(salt: string, label: 'name' | 'dob', value: string): string {
  return createHash('sha256')
    .update(salt, 'utf8')
    .update(`\n${label}\n`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function hashHolderName(salt: string, name: string): string {
  return saltedHash(salt, 'name', normalizeHolderName(name));
}

export function hashHolderDob(salt: string, dob: string): string {
  const normalized = normalizeHolderDob(dob);
  if (!normalized) throw new Error('holder date of birth is not a calendar date');
  return saltedHash(salt, 'dob', normalized);
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Salt and hashes for the name (and optional date of birth) printed on the PDF. */
export function createHolderBinding(input: {
  name: string;
  dateOfBirth: string | null;
}): HolderBinding {
  const normalizedName = normalizeHolderName(input.name);
  if (!normalizedName) throw new Error('holder name is empty');
  const salt = randomBytes(32).toString('hex');
  const dob = input.dateOfBirth ? normalizeHolderDob(input.dateOfBirth) : null;
  return {
    salt,
    nameHash: saltedHash(salt, 'name', normalizedName),
    dobHash: dob ? saltedHash(salt, 'dob', dob) : null,
  };
}

/**
 * True only when the typed name matches the sealed hash. A typed date of birth
 * is checked only when one was sealed; a missing sealed date is ignored.
 * One boolean — the caller must not learn which part differed.
 */
export function holderDetailsMatch(input: {
  salt: string;
  nameHash: string;
  dobHash: string | null;
  name: string;
  dateOfBirth?: string | null;
}): boolean {
  const nameOk = hashesEqual(hashHolderName(input.salt, input.name), input.nameHash);
  const suppliedDob = input.dateOfBirth?.trim() ?? '';
  if (!suppliedDob || !input.dobHash) return nameOk;
  const normalized = normalizeHolderDob(suppliedDob);
  if (!normalized) return false;
  return nameOk && hashesEqual(hashHolderDob(input.salt, normalized), input.dobHash);
}
