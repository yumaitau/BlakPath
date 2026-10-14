import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Printed-letter PDF.
 *
 * One or more A4 pages of the letter a staff member is about to post.
 * Standard fonts only encode WinAnsi, so characters outside that range are
 * replaced. The bytes are what gets printed; the database stores the letter
 * text separately.
 */

export interface LetterPdfInput {
  readonly organisationName: string;
  readonly subject: string;
  readonly body: string;
  readonly applicationReference: string;
}

/** pdf-lib's standard fonts throw on code points outside WinAnsi. */
function winAnsi(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (char === '\n' || char === '\t') return char;
      if (code >= 0x20 && code <= 0xff) return char;
      return '?';
    })
    .join('');
}

function wrapLine(
  text: string,
  widthOf: (line: string) => number,
  maxWidth: number,
): string[] {
  if (text.trim() === '') return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && widthOf(next) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Render a letter to PDF bytes. */
export async function renderLetterPdf(input: LetterPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.12, 0.11);
  const muted = rgb(0.4, 0.38, 0.36);

  const organisationName = winAnsi(input.organisationName);
  const subject = winAnsi(input.subject);
  const body = winAnsi(input.body);
  const reference = winAnsi(input.applicationReference);

  const margin = 56;
  const lineHeight = 15;
  let page = doc.addPage([595.28, 841.89]);
  let { width, height } = page.getSize();
  let y = height - margin;

  const ensure = (needed: number) => {
    if (y - needed >= margin) return;
    page = doc.addPage([595.28, 841.89]);
    ({ width, height } = page.getSize());
    y = height - margin;
  };

  const draw = (text: string, size: number, used = font, color = ink) => {
    const lines = wrapLine(
      text,
      (line) => used.widthOfTextAtSize(line, size),
      width - margin * 2,
    );
    for (const line of lines) {
      ensure(lineHeight);
      page.drawText(line, { x: margin, y, size, font: used, color });
      y -= lineHeight;
    }
  };

  draw(organisationName, 14, bold);
  y -= 6;
  draw(subject, 16, bold);
  y -= 4;
  draw(`Application ${reference}`, 10, font, muted);
  y -= 12;
  for (const paragraph of body.split('\n')) {
    draw(paragraph, 11);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
