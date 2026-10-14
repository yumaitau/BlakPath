import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fontkitNamespace from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { toBuffer as qrPng } from 'qrcode';

/**
 * Certificate PDF rendering.
 *
 * A one-page document. It states plainly that an authorised organisation has
 * RECORDED a confirmation decision made by its people — it never presents
 * itself as a machine determination. Names are set in subsetted Noto Sans
 * (WinAnsi cannot encode characters such as ŋ). Every run is wrapped or
 * shrunk inside the margin, and the verify URL is printed on its own line
 * with a QR code.
 */

export const CERTIFICATE_PAGE_WIDTH_PT = 595.28;
export const CERTIFICATE_PAGE_HEIGHT_PT = 841.89;
/** Inset used on every edge. Text must end at or before width − this. */
export const CERTIFICATE_MARGIN_PT = 70;

const VALUE_X = 240;
const QR_SIZE = 120;
const LINE_GAP = 4;
const SECTION_GAP = 18;

const INTRO =
  'This certifies that the organisation named above has recorded a confirmation decision, made by its authorised people, in respect of:';
const FOOTER =
  'This certificate records a decision made by authorised humans. It is not a machine determination.';

export interface CertificateRenderInput {
  organisationName: string;
  applicantName: string;
  reference: string;
  verificationCode: string;
  /** ISO date string for the issue date shown on the certificate. */
  issuedOn: string;
  verifyUrl: string;
  /** Optional organisation brand colour (hex, e.g. "#7a4a2b") for the heading. */
  brandColor?: string | null;
}

type Ink = ReturnType<typeof rgb>;
type FontkitInstance = Parameters<PDFDocument['registerFontkit']>[0];

/** `@pdf-lib/fontkit` types omit the default export the package actually ships. */
function loadFontkit(): FontkitInstance {
  const ns = fontkitNamespace as unknown as FontkitInstance & {
    default?: FontkitInstance;
  };
  if (typeof ns.create === 'function') return ns;
  if (ns.default && typeof ns.default.create === 'function') return ns.default;
  throw new Error('Certificate font engine failed to load.');
}

let fontBytes: Promise<{ regular: Buffer; bold: Buffer }> | undefined;

function loadFontBytes(): Promise<{ regular: Buffer; bold: Buffer }> {
  fontBytes ??= (async () => {
    const dir = join(process.cwd(), 'src/domains/certificates/fonts');
    const [regular, bold] = await Promise.all([
      readFile(join(dir, 'NotoSans-Regular.ttf')),
      readFile(join(dir, 'NotoSans-Bold.ttf')),
    ]);
    return { regular, bold };
  })().catch((error: unknown) => {
    fontBytes = undefined;
    throw error;
  });
  return fontBytes;
}

/** Parse a `#rrggbb` hex colour to pdf-lib rgb, or null if malformed. */
function parseHexColor(hex: string | null | undefined): Ink | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function graphemes(text: string): string[] {
  return [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((part) => part.segment);
}

function breakToken(
  token: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const parts: string[] = [];
  let current = '';
  for (const glyph of graphemes(token)) {
    const next = current + glyph;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      parts.push(current);
      current = glyph;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }
    const pieces = breakToken(word, font, size, maxWidth);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Prefer one line by shrinking, then wrap. `wrap` keeps the preferred size
 * and shrinks only when a single word still overflows, then breaks that word.
 */
function layoutText(
  text: string,
  font: PDFFont,
  maxWidth: number,
  preferred: number,
  min: number,
  mode: 'wrap' | 'shrink-then-wrap',
): { lines: string[]; size: number } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { lines: [], size: preferred };

  let size = preferred;
  const fits =
    mode === 'shrink-then-wrap'
      ? (next: number) => font.widthOfTextAtSize(normalized, next) <= maxWidth
      : (next: number) =>
          normalized
            .split(' ')
            .every((word) => font.widthOfTextAtSize(word, next) <= maxWidth);
  while (size > min && !fits(size)) size = Math.max(min, size - 0.5);

  const lines = wrapText(normalized, font, size, maxWidth);
  for (const line of lines) {
    if (font.widthOfTextAtSize(line, size) > maxWidth + 0.01) {
      throw new Error('Certificate text does not fit within the page margins.');
    }
  }
  return { lines, size };
}

function drawLines(
  page: PDFPage,
  lines: string[],
  font: PDFFont,
  size: number,
  y: number,
  color: Ink,
  xFor: (line: string) => number,
): number {
  const step = size + LINE_GAP;
  let cursor = y;
  for (const line of lines) {
    page.drawText(line, { x: xFor(line), y: cursor, size, font, color });
    cursor -= step;
  }
  return cursor;
}

/** Render the certificate to PDF bytes. Pure aside from pdf-lib and font IO. */
export async function renderCertificatePdf(
  input: CertificateRenderInput,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(loadFontkit());
  const { regular: regularBytes, bold: boldBytes } = await loadFontBytes();
  const body = await doc.embedFont(new Uint8Array(regularBytes), { subset: true });
  const title = await doc.embedFont(new Uint8Array(boldBytes), { subset: true });

  const page = doc.addPage([CERTIFICATE_PAGE_WIDTH_PT, CERTIFICATE_PAGE_HEIGHT_PT]);
  const { width, height } = page.getSize();
  const contentWidth = width - CERTIFICATE_MARGIN_PT * 2;
  const ink = rgb(0.13, 0.12, 0.11);
  const muted = rgb(0.4, 0.38, 0.36);
  const brand = parseHexColor(input.brandColor) ?? ink;

  const footer = layoutText(FOOTER, body, contentWidth, 9, 8, 'wrap');
  const footerStep = footer.size + LINE_GAP;
  const footerTop =
    CERTIFICATE_MARGIN_PT + Math.max(0, footer.lines.length - 1) * footerStep;
  const contentFloor = footerTop + footer.size + 16;

  const qrBytes = await qrPng(input.verifyUrl, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    color: { dark: '#211F1C', light: '#FFFFFF' },
  });
  const qr = await doc.embedPng(qrBytes);

  const guard = (y: number) => {
    if (y < contentFloor) {
      throw new Error('Certificate layout does not fit on one page.');
    }
  };

  const centered = (
    text: string,
    font: PDFFont,
    preferred: number,
    min: number,
    y: number,
    color: Ink,
  ) => {
    const laid = layoutText(text, font, contentWidth, preferred, min, 'shrink-then-wrap');
    return drawLines(page, laid.lines, font, laid.size, y, color, (line) => {
      return (width - font.widthOfTextAtSize(line, laid.size)) / 2;
    });
  };

  const left = (
    text: string,
    font: PDFFont,
    preferred: number,
    min: number,
    y: number,
    color: Ink,
    mode: 'wrap' | 'shrink-then-wrap',
  ) => {
    const laid = layoutText(text, font, contentWidth, preferred, min, mode);
    return drawLines(
      page,
      laid.lines,
      font,
      laid.size,
      y,
      color,
      () => CERTIFICATE_MARGIN_PT,
    );
  };

  let y = height - CERTIFICATE_MARGIN_PT - 18;
  y = centered(input.organisationName, title, 18, 12, y, brand);
  guard(y);
  y -= SECTION_GAP;
  y = centered('Confirmation of Aboriginality', title, 24, 16, y, ink);
  guard(y);
  y -= SECTION_GAP;
  y = left(INTRO, body, 12, 9, y, muted, 'wrap');
  guard(y);
  y -= SECTION_GAP;
  y = centered(input.applicantName, title, 20, 11, y, ink);
  guard(y);
  y -= SECTION_GAP;

  const fields: Array<[string, string]> = [
    ['Certificate reference', input.reference],
    ['Issued on', input.issuedOn],
    ['Verification code', input.verificationCode],
  ];
  for (const [label, value] of fields) {
    const labelMax = VALUE_X - CERTIFICATE_MARGIN_PT - 12;
    const valueMax = width - CERTIFICATE_MARGIN_PT - VALUE_X;
    const labelLaid = layoutText(label, body, labelMax, 11, 8, 'shrink-then-wrap');
    const valueLaid = layoutText(value, title, valueMax, 11, 8, 'shrink-then-wrap');
    const labelEnd = drawLines(
      page,
      labelLaid.lines,
      body,
      labelLaid.size,
      y,
      muted,
      () => CERTIFICATE_MARGIN_PT,
    );
    const valueEnd = drawLines(
      page,
      valueLaid.lines,
      title,
      valueLaid.size,
      y,
      ink,
      () => VALUE_X,
    );
    y = Math.min(labelEnd, valueEnd) - 6;
    guard(y);
  }

  y -= 4;
  y = left('Verify at', body, 11, 9, y, muted, 'wrap');
  y = left(input.verifyUrl, title, 11, 8, y, ink, 'shrink-then-wrap');
  guard(y);

  const qrBottom = y - 8 - QR_SIZE;
  guard(qrBottom);
  page.drawImage(qr, {
    x: CERTIFICATE_MARGIN_PT,
    y: qrBottom,
    width: QR_SIZE,
    height: QR_SIZE,
  });

  let footerY = footerTop;
  for (const line of footer.lines) {
    page.drawText(line, {
      x: CERTIFICATE_MARGIN_PT,
      y: footerY,
      size: footer.size,
      font: body,
      color: muted,
    });
    footerY -= footerStep;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
