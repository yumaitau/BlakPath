import { createHash } from 'node:crypto';

/**
 * Pure certificate-template helpers.
 *
 * Versioning, content identity, logo sniffing and the public verification
 * projection live here so they can be tested without a database. Nothing in
 * this module decides Aboriginality or picks a signatory — it only checks and
 * formats what an authorised person already authored.
 */

/** Printed when a development seed needs a first template. Orgs replace it. */
export const DEFAULT_CERTIFICATE_WORDING =
  'This certifies that the organisation named above has recorded a confirmation decision, made by its authorised people, in respect of the person named on this certificate.';

/** Decoded logo cap. The certificate is one page; a large image does not belong. */
export const CERTIFICATE_LOGO_MAX_BYTES = 512 * 1024;

const PUNCTUATION: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u00A0': ' ',
};

/** WinAnsi-safe text: ASCII plus Latin-1, after curly punctuation is flattened. */
const PRINTABLE = /^[\n\u0020-\u007E\u00A0-\u00FF]*$/;

/** Flatten curly quotes and dashes so the certificate font can encode the text. */
export function normalizeCertificateText(value: string): string {
  let out = '';
  for (const ch of value) {
    out += PUNCTUATION[ch] ?? ch;
  }
  return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** True when every character can be drawn with the certificate's standard font. */
export function isCertificatePrintable(value: string): boolean {
  return PRINTABLE.test(value);
}

/**
 * Display an ABN. Eleven digits are grouped; anything else is shown as stored.
 * This does not check that the number is a real or valid business registration.
 */
export function formatAbn(abn: string | null | undefined): string | null {
  if (!abn) return null;
  const trimmed = abn.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\s+/g, '');
  if (/^\d{11}$/.test(digits)) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return trimmed;
}

/** PNG or JPEG from magic bytes. Declared content-type is never trusted. */
export function detectLogoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** Canonical identity of a template version. Key order is fixed. */
export function templateContentHash(input: {
  wording: string;
  signatoryName: string;
  signatoryRole: string;
  logoSha256: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        wording: input.wording,
        signatoryName: input.signatoryName,
        signatoryRole: input.signatoryRole,
        logoSha256: input.logoSha256,
      }),
    )
    .digest('hex');
}

/**
 * Decide whether a publish writes a new version.
 * Identical content reuses the current version and is not audited again.
 */
export function planTemplatePublish(
  current: { version: number; contentHash: string } | null,
  contentHash: string,
): { action: 'unchanged'; version: number } | { action: 'publish'; version: number } {
  if (current && current.contentHash === contentHash) {
    return { action: 'unchanged', version: current.version };
  }
  return { action: 'publish', version: (current?.version ?? 0) + 1 };
}

/** Reason stored on the revoked row. The reference is not applicant PII. */
export function supersededRevokeReason(newReference: string): string {
  return `Superseded by ${newReference}`;
}

/** Word-wrap a single paragraph to a measured width. Newlines are hard breaks. */
export function wrapCertificateLines(
  text: string,
  maxWidth: number,
  widthOf: (line: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0] ?? '';
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (widthOf(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}
