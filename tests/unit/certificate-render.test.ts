import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getDocument,
  GlobalWorkerOptions,
  ImageKind,
  OPS,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import jsQR from 'jsqr';
import {
  CERTIFICATE_MARGIN_PT,
  renderCertificatePdf,
  type CertificateRenderInput,
} from '@/domains/certificates/render';
import names from './fixtures/certificate-names.json';
import goldenText from './fixtures/certificate-render.golden.json';

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

type FixtureCase = CertificateRenderInput & { id: string };

const cases = names.cases as FixtureCase[];

type TextRun = { str: string; x: number; y: number; width: number };
type PdfImage = {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  kind: number;
};

function isTextItem(
  item: unknown,
): item is { str: string; width: number; transform: number[] } {
  if (typeof item !== 'object' || item === null) return false;
  if (!('str' in item) || !('width' in item) || !('transform' in item)) return false;
  return (
    typeof item.str === 'string' &&
    typeof item.width === 'number' &&
    Array.isArray(item.transform)
  );
}

async function loadPage(pdf: Buffer): Promise<{ page: PDFPageProxy; width: number }> {
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const width = page.getViewport({ scale: 1 }).width;
  return { page, width };
}

async function textRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!isTextItem(item) || item.str.length === 0) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    if (x === undefined || y === undefined) continue;
    runs.push({ str: item.str, x, y, width: item.width });
  }
  return runs;
}

function readingOrder(runs: TextRun[]): TextRun[] {
  return [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
}

function normalizedText(runs: TextRun[]): string {
  const sorted = readingOrder(runs);
  const lines: TextRun[][] = [];
  for (const run of sorted) {
    const current = lines.at(-1);
    const anchor = current?.[0];
    if (!current || !anchor || Math.abs(anchor.y - run.y) > 2) lines.push([run]);
    else current.push(run);
  }
  return lines
    .map((line) =>
      line
        .slice()
        .sort((a, b) => a.x - b.x)
        .map((run) => run.str)
        .join(''),
    )
    .join('\n')
    .trim();
}

function urlRuns(runs: TextRun[], url: string): TextRun[] {
  const sorted = readingOrder(runs);
  for (let i = 0; i < sorted.length; i++) {
    let acc = '';
    for (let j = i; j < sorted.length; j++) {
      acc += sorted[j]!.str;
      if (acc === url) return sorted.slice(i, j + 1);
      if (!url.startsWith(acc)) break;
    }
  }
  return [];
}

function toRgba(image: PdfImage): Uint8ClampedArray {
  const { data, width, height, kind } = image;
  if (kind === ImageKind.RGBA_32BPP) {
    return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  }
  if (kind !== ImageKind.RGB_24BPP) {
    throw new Error(`Unsupported certificate image kind ${kind}.`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    rgba[j] = data[i] ?? 0;
    rgba[j + 1] = data[i + 1] ?? 0;
    rgba[j + 2] = data[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  return rgba;
}

function flipVertical(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    out.set(rgba.subarray(src, src + row), y * row);
  }
  return out;
}

function decodeQr(image: PdfImage): string | null {
  const attempts = [toRgba(image)];
  attempts.push(flipVertical(attempts[0]!, image.width, image.height));
  for (const pixels of attempts) {
    const code = jsQR(pixels, image.width, image.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (code?.data) return code.data;
  }
  return null;
}

async function paintedImages(page: PDFPageProxy): Promise<PdfImage[]> {
  const ops = await page.getOperatorList();
  const images: PdfImage[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
    const name = ops.argsArray[i]?.[0];
    if (typeof name !== 'string') continue;
    const image = await new Promise<PdfImage>((resolve, reject) => {
      try {
        page.objs.get(name, (data: PdfImage) => resolve(data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('image lookup failed'));
      }
    });
    if (image?.data && image.width > 0 && image.height > 0) images.push(image);
  }
  return images;
}

describe('certificate name fixtures', () => {
  it('covers eng, apostrophes, diacritics, and a 120-character name', () => {
    expect(cases.some((item) => item.applicantName.includes('ŋ'))).toBe(true);
    expect(cases.some((item) => item.applicantName.includes("Galiwin'ku"))).toBe(true);
    expect(
      cases.some((item) =>
        [...item.applicantName].some((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code > 0x00ff;
        }),
      ),
    ).toBe(true);
    expect(cases.some((item) => item.applicantName.length === 120)).toBe(true);
    expect(cases.some((item) => item.organisationName.includes('\u2019'))).toBe(true);
  });
});

describe('certificate PDF rendering', () => {
  it.each(cases)(
    '$id renders inside the margin, shows the verify URL, and the QR scans to it',
    async (item) => {
      const pdf = await renderCertificatePdf(item);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

      const { page, width } = await loadPage(pdf);
      const runs = await textRuns(page);
      const right = width - CERTIFICATE_MARGIN_PT;
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.x + run.width).toBeLessThanOrEqual(right);
        expect(run.x).toBeGreaterThanOrEqual(CERTIFICATE_MARGIN_PT);
      }

      const compact = runs
        .map((run) => run.str)
        .join('')
        .replace(/\s+/g, '');
      expect(compact).toContain(item.applicantName.replace(/\s+/g, ''));
      expect(compact).toContain(item.organisationName.replace(/\s+/g, ''));
      expect(compact).toContain(item.verifyUrl);

      const link = urlRuns(runs, item.verifyUrl);
      expect(link.length).toBeGreaterThan(0);
      const label = runs.find((run) => run.str === 'Verify at');
      expect(label).toBeDefined();
      expect(link[0]!.y).toBeLessThan((label?.y ?? 0) - 0.5);
      for (const run of link) {
        expect(run.x).toBeLessThanOrEqual(CERTIFICATE_MARGIN_PT + 1);
        expect(run.x + run.width).toBeLessThanOrEqual(right);
      }

      const images = await paintedImages(page);
      const decoded = images
        .map((image) => decodeQr(image))
        .filter((value) => value !== null);
      expect(decoded).toContain(item.verifyUrl);

      const expected = goldenText[item.id as keyof typeof goldenText];
      expect(normalizedText(runs)).toBe(expected);
    },
  );
});
