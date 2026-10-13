import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatAbn, wrapCertificateLines } from './template';

/**
 * Certificate PDF rendering.
 *
 * One page. The organisation authors the body wording, logo and signatory;
 * the meeting date, resolution date and ABN are facts already on the
 * organisation or the human decision. The footer states that the document
 * records a human decision — that sentence is platform text, not something an
 * organisation can remove.
 *
 * Kept in its own module so the service stays about lifecycle and this stays
 * about layout.
 */

export interface CertificateRenderInput {
  organisationName: string;
  /** Stored ABN. Omitted from the page when absent. */
  abn?: string | null;
  applicantName: string;
  reference: string;
  verificationCode: string;
  /** ISO date string for the issue date shown on the certificate. */
  issuedOn: string;
  verifyUrl: string;
  /** Organisation-authored body. Already checked as printable. */
  wording: string;
  signatoryName: string;
  signatoryRole: string;
  /** ISO date of the committee meeting, when the decision was tied to one. */
  meetingOn?: string | null;
  /** ISO date the authorised human finalised the decision. */
  resolutionOn?: string | null;
  /** Optional organisation brand colour (hex, e.g. "#7a4a2b") for the heading. */
  brandColor?: string | null;
  /** PNG bytes. Mutually exclusive with `logoJpeg` in practice. */
  logoPng?: Uint8Array | null;
  /** JPEG bytes. */
  logoJpeg?: Uint8Array | null;
}

/** Parse a `#rrggbb` hex colour to pdf-lib rgb, or null if malformed. */
function parseHexColor(hex: string | null | undefined): ReturnType<typeof rgb> | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Render the certificate to PDF bytes. Pure aside from pdf-lib's own work. */
export async function renderCertificatePdf(
  input: CertificateRenderInput,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait, points.
  const { width, height } = page.getSize();

  const title = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.13, 0.12, 0.11);
  const muted = rgb(0.4, 0.38, 0.36);
  const brand = parseHexColor(input.brandColor) ?? ink;
  const margin = 64;
  const contentWidth = width - margin * 2;

  const centre = (text: string, font: PDFFont, size: number, y: number, color = ink) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (width - w) / 2, y, size, font, color });
  };

  let y = height - 56;
  const logoBytes = input.logoPng ?? input.logoJpeg ?? null;
  if (logoBytes) {
    const image = input.logoPng
      ? await doc.embedPng(input.logoPng)
      : await doc.embedJpg(input.logoJpeg!);
    const maxH = 64;
    const maxW = 180;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    y -= h;
    page.drawImage(image, { x: (width - w) / 2, y, width: w, height: h });
    y -= 18;
  }

  centre(input.organisationName, title, 16, y, brand);
  y -= 18;
  const abn = formatAbn(input.abn);
  if (abn) {
    centre(`ABN ${abn}`, body, 10, y, muted);
    y -= 16;
  }

  y -= 10;
  centre('Confirmation of Aboriginality', title, 20, y);
  y -= 28;

  const wordingLines = wrapCertificateLines(input.wording, contentWidth, (line) =>
    body.widthOfTextAtSize(line, 11),
  );
  for (const line of wordingLines) {
    page.drawText(line, { x: margin, y, size: 11, font: body, color: muted });
    y -= 15;
  }

  y -= 12;
  centre(input.applicantName, title, 18, y);
  y -= 32;

  const rows: Array<[string, string]> = [
    ['Certificate reference', input.reference],
    ['Issued on', input.issuedOn],
  ];
  if (input.meetingOn) rows.push(['Meeting date', input.meetingOn]);
  if (input.resolutionOn) rows.push(['Resolution date', input.resolutionOn]);
  rows.push(
    ['Verification code', input.verificationCode],
    ['Verify at', input.verifyUrl],
  );

  for (const [label, value] of rows) {
    page.drawText(label, { x: margin, y, size: 10, font: body, color: muted });
    const used = drawValue(page, value, title, 10, ink, 230, y, width - margin);
    y -= Math.max(16, used);
  }

  y -= 14;
  page.drawText('Authorised signatory', {
    x: margin,
    y,
    size: 10,
    font: body,
    color: muted,
  });
  y -= 16;
  page.drawText(input.signatoryName, { x: margin, y, size: 12, font: title, color: ink });
  y -= 15;
  page.drawText(input.signatoryRole, { x: margin, y, size: 11, font: body, color: ink });

  const footer =
    'This certificate records a decision made by authorised humans. It is not a ' +
    'machine determination.';
  const footerLines = wrapCertificateLines(footer, contentWidth, (line) =>
    body.widthOfTextAtSize(line, 9),
  );
  let footerY = 64;
  for (const line of footerLines) {
    page.drawText(line, { x: margin, y: footerY, size: 9, font: body, color: muted });
    footerY -= 12;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Draw a value, wrapping if it would run off the right margin.
 * Returns the vertical space consumed, in points.
 */
function drawValue(
  page: PDFPage,
  value: string,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
  x: number,
  y: number,
  right: number,
): number {
  const maxWidth = right - x;
  const lineStep = size + 3;
  if (font.widthOfTextAtSize(value, size) <= maxWidth) {
    page.drawText(value, { x, y, size, font, color });
    return lineStep;
  }
  const lines = wrapCertificateLines(value, maxWidth, (line) =>
    font.widthOfTextAtSize(line, size),
  ).slice(0, 3);
  let lineY = y;
  for (const line of lines) {
    page.drawText(line, { x, y: lineY, size, font, color });
    lineY -= lineStep;
  }
  return lines.length * lineStep;
}
