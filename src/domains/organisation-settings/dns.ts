/**
 * DNS TXT domain verification — pure rules.
 *
 * An administrator publishes a TXT record at `_blakpath-verify.<domain>` whose
 * value is `blakpath-verify=<token>`. A match proves control of the domain.
 * The token is single-use: a successful check consumes it.
 *
 * PRODUCT INVARIANT: verifying a domain proves DNS control only. It never
 * says anything about a person's identity.
 */

export const VERIFICATION_HOST_LABEL = '_blakpath-verify';
export const VERIFICATION_PREFIX = 'blakpath-verify=';

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface DomainDnsInstruction {
  type: 'TXT';
  host: string;
  value: string;
}

export interface OrganisationDomainView {
  id: string;
  domain: string;
  verified: boolean;
  /** Present only while the domain is unverified and a token still exists. */
  dns: DomainDnsInstruction | null;
}

/** Lower-case a hostname and reject anything that is not a dotted domain. */
export function parseDomain(raw: string): { ok: true; domain: string } | { ok: false } {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(value)) return { ok: false };
  return { ok: true, domain: value };
}

export function verificationHostname(domain: string): string {
  return `${VERIFICATION_HOST_LABEL}.${domain}`;
}

export function verificationTxtValue(token: string): string {
  return `${VERIFICATION_PREFIX}${token}`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Join chunked TXT strings the way DNS presents a single record. */
export function flattenTxt(records: readonly (readonly string[])[]): string[] {
  return records.map((chunks) => unquote(chunks.join('')));
}

export function txtProvesControl(
  records: readonly (readonly string[])[],
  token: string,
): boolean {
  if (token.length === 0) return false;
  const expected = verificationTxtValue(token);
  return flattenTxt(records).some((value) => value === expected);
}

export interface DomainCheckState {
  verified: boolean;
  /** Null once a successful check has consumed the token. */
  token: string | null;
  matched: boolean;
}

/**
 * Next stored state after a TXT lookup.
 * A match sets `verified` and clears the token. Anything else leaves both.
 */
export function domainAfterCheck(input: {
  verified: boolean;
  token: string | null;
  records: readonly (readonly string[])[];
}): DomainCheckState {
  if (input.verified || !input.token) {
    return { verified: input.verified, token: input.token, matched: false };
  }
  if (!txtProvesControl(input.records, input.token)) {
    return { verified: false, token: input.token, matched: false };
  }
  return { verified: true, token: null, matched: true };
}
