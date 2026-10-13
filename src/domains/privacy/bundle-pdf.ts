import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { SubjectBundle } from './bundle';

/**
 * Subject-bundle PDF rendering.
 *
 * A plain, paginated document: one heading per section, one block per record,
 * one line per field. Kept separate from the service so it stays about layout.
 * Standard PDF fonts cannot encode every character, so text is reduced to what
 * the font can draw and anything else is shown as `?` rather than failing.
 */

const PAGE: [number, number] = [595.28, 841.89]; // A4 portrait, points.
const MARGIN = 56;
const BODY_SIZE = 9.5;
const LINE = 13;

/** Split camelCase keys into readable labels: `relativeName` → `Relative name`. */
export function labelFor(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Replace characters the font cannot encode. */
function drawable(font: PDFFont, text: string, cache: Map<string, boolean>): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n' || ch === '\t') {
      out += ' ';
      continue;
    }
    let ok = cache.get(ch);
    if (ok === undefined) {
      try {
        font.encodeText(ch);
        ok = true;
      } catch {
        ok = false;
      }
      cache.set(ch, ok);
    }
    out += ok ? ch : '?';
  }
  return out;
}

/** Greedy word wrap to `width` points; very long words are hard-split. */
export function wrapText(
  text: string,
  width: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while (measure(rest) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > width) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export async function renderBundlePdf(bundle: SubjectBundle): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Personal information held by ${bundle.organisationName}`);
  doc.setCreator('BlakPath');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.12, 0.11);
  const muted = rgb(0.4, 0.38, 0.36);
  const cache = new Map<string, boolean>();
  const width = PAGE[0] - MARGIN * 2;

  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  const ensure = (height: number) => {
    if (y - height < MARGIN) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN;
    }
  };

  const write = (
    text: string,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      indent?: number;
    },
  ) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const indent = opts.indent ?? 0;
    const safe = drawable(font, text, cache);
    for (const line of wrapText(safe, width - indent, (s) =>
      font.widthOfTextAtSize(s, size),
    )) {
      ensure(size + 4);
      page.drawText(line, {
        x: MARGIN + indent,
        y,
        size,
        font,
        color: opts.color ?? ink,
      });
      y -= Math.max(LINE, size + 4);
    }
  };

  write(`Personal information held by ${bundle.organisationName}`, {
    font: bold,
    size: 16,
  });
  y -= 4;
  write(`Prepared ${bundle.generatedAt} in response to request ${bundle.requestId}.`, {
    color: muted,
  });
  write(
    'This document lists the personal information the organisation holds about you. ' +
      'Information that has been withheld, for example because it is about another person, is shown as [REDACTED]. ' +
      'If anything here is wrong you can ask for it to be corrected.',
    { color: muted },
  );
  y -= LINE;

  for (const section of bundle.sections) {
    ensure(LINE * 3);
    write(`${section.title} (${section.records.length})`, { font: bold, size: 12 });
    y -= 2;
    if (section.records.length === 0) {
      write('Nothing held.', { color: muted, indent: 8 });
    }
    for (const record of section.records) {
      ensure(LINE * 2);
      write(`Record ${record.id}`, { font: bold, color: muted, indent: 8 });
      for (const [key, value] of Object.entries(record.fields)) {
        write(`${labelFor(key)}: ${value ?? '—'}`, { indent: 16 });
      }
      y -= 4;
    }
    y -= LINE / 2;
  }

  const pages = doc.getPages();
  pages.forEach((p, index) => {
    p.drawText(`Page ${index + 1} of ${pages.length}`, {
      x: MARGIN,
      y: MARGIN / 2,
      size: 8,
      font: regular,
      color: muted,
    });
  });

  return Buffer.from(await doc.save());
}
