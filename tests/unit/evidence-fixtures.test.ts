import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { detectContentType } from '@/domains/evidence/detect';
import { verifiedContentType } from '@/domains/evidence/status';

/**
 * Fixture-based acceptance: real files run through the same streamed detection
 * the worker uses, then the post-upload type rules.
 *
 * Fixtures (tests/fixtures/evidence):
 *   - letter.doc       Word 97-2003 document (MS Compound File) from macOS textutil.
 *   - letter.docx      Office Open XML document from macOS textutil.
 *   - iphone.heic      HEIC from Apple's ImageIO encoder — the same `ftyp heic`
 *                      / `mif1 MiPr miaf MiHB heic` brands an iPhone camera writes.
 *   - photo-mif1.heif  The same image with major brand `mif1`, as written by
 *                      many Android and desktop encoders.
 *   - renamed-exe.doc  A Windows executable (MZ/PE header) renamed to .doc.
 */
function fixture(name: string): Readable {
  return Readable.from(
    readFileSync(new URL(`../fixtures/evidence/${name}`, import.meta.url)),
  );
}

async function verify(name: string, declared: string, fileName = name) {
  const detected = await detectContentType(fixture(name));
  return { detected, stored: verifiedContentType({ declared, detected, fileName }) };
}

describe('evidence fixtures', () => {
  it('accepts a real legacy Word .doc', async () => {
    const result = await verify('letter.doc', 'application/msword');
    expect(result.detected).toBe('application/x-cfb');
    expect(result.stored).toBe('application/msword');
  });

  it('accepts a real Word .docx', async () => {
    const docx =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect((await verify('letter.docx', docx)).stored).toBe(docx);
  });

  it('accepts an iPhone HEIC whether declared HEIC or HEIF', async () => {
    expect((await verify('iphone.heic', 'image/heic')).stored).toBe('image/heic');
    expect((await verify('iphone.heic', 'image/heif')).stored).toBe('image/heic');
  });

  it('accepts a mif1-branded HEIF declared as HEIC', async () => {
    const result = await verify('photo-mif1.heif', 'image/heic', 'IMG_0002.HEIC');
    expect(result.detected).toBe('image/heif');
    expect(result.stored).toBe('image/heif');
  });

  it('still rejects an executable renamed to .doc', async () => {
    const result = await verify('renamed-exe.doc', 'application/msword');
    expect(result.detected).toBe('application/x-msdownload');
    expect(result.stored).toBeNull();
  });

  it('rejects a real .doc declared as a different type', async () => {
    expect(
      (await verify('letter.doc', 'application/pdf', 'letter.pdf')).stored,
    ).toBeNull();
  });
});
