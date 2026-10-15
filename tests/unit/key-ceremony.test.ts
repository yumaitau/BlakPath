import { execFile } from 'node:child_process';
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { combine } from 'shamir-secret-sharing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_FILE,
  MANIFEST_FILE,
  SEALED_MATERIAL_FILE,
  checkFile,
  custodianShareFile,
  parseManifest,
  recoverKeyMaterial,
  runCeremony,
  serializeManifest,
  type CeremonyOutput,
} from '@/lib/key-ceremony/escrow';
import {
  generateKeyMaterial,
  keyCheckValue,
  loadRsaPublicKey,
  sha256Hex,
} from '@/lib/key-ceremony/primitives';
import { renderTranscript } from '@/lib/key-ceremony/transcript';

const ORG_ID = '018f0000-0000-7000-8000-000000000002';
const TARGET_ARN =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';

interface Pair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function rsaPair(bits: number): Pair {
  return generateKeyPairSync('rsa', { modulusLength: bits });
}

/** What KMS does with RSAES_OAEP_SHA_256 (import, or escrow-key Decrypt). */
function oaepDecrypt(pair: Pair, blob: Buffer): Buffer {
  return privateDecrypt(
    {
      key: pair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    blob,
  );
}

function file(output: CeremonyOutput, name: string): Buffer {
  const bytes = output.files.get(name);
  if (!bytes) throw new Error(`missing ${name}`);
  return bytes;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, i) =>
    combinations(items.slice(i + 1), size - 1).map((rest) => [item, ...rest]),
  );
}

let kms: Pair;
let vault: Pair;

beforeAll(() => {
  kms = rsaPair(3072);
  vault = rsaPair(3072);
});

describe('key ceremony primitives', () => {
  it('generates distinct 256-bit material', () => {
    const a = generateKeyMaterial();
    const b = generateKeyMaterial();
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it('loads the public key as PEM, base64 DER or raw DER', () => {
    const der = kms.publicKey.export({ format: 'der', type: 'spki' });
    const pem = Buffer.from(kms.publicKey.export({ format: 'pem', type: 'spki' }));
    for (const input of [pem, Buffer.from(der.toString('base64')), der]) {
      expect(loadRsaPublicKey(input, 'k').equals(kms.publicKey)).toBe(true);
    }
  });

  it('refuses RSA-2048 and non-RSA keys', () => {
    const small = rsaPair(2048).publicKey.export({ format: 'der', type: 'spki' });
    expect(() => loadRsaPublicKey(small, 'KMS wrapping key')).toThrow(/RSA-3072/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'der',
      type: 'spki',
    });
    expect(() => loadRsaPublicKey(ec, 'Escrow public key')).toThrow(/RSA/);
    expect(() => loadRsaPublicKey(Buffer.from('not a key!'), 'k')).toThrow(/readable/);
  });
});

describe('ceremony: KMS import and whole-material escrow', () => {
  it('produces an importable key and a vault-recoverable package', async () => {
    const material = generateKeyMaterial();
    const output = await runCeremony({
      material,
      organisationId: ORG_ID,
      kmsWrappingKey: kms.publicKey,
      escrowPublicKey: vault.publicKey,
      purpose: 'escrow',
      targetKeyArn: TARGET_ARN,
    });
    const { manifest } = output;

    // KMS ImportKeyMaterial unwraps RSAES_OAEP_SHA_256 to the raw material.
    expect(oaepDecrypt(kms, file(output, IMPORT_FILE)).equals(material)).toBe(true);
    expect(manifest.escrow.scheme).toBe('whole');
    expect(manifest.escrow.sealed).toHaveLength(1);
    expect(manifest.keyMaterial.checkValue).toBe(keyCheckValue(material));
    expect(manifest.targetKeyArn).toBe(TARGET_ARN);

    for (const [name, bytes] of output.files) {
      expect(checkFile(manifest, name, bytes)).toBe('match');
      expect(bytes.includes(material)).toBe(false);
    }
    const tampered = Buffer.from(file(output, SEALED_MATERIAL_FILE));
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(checkFile(manifest, SEALED_MATERIAL_FILE, tampered)).toBe('mismatch');
    expect(checkFile(manifest, 'other.bin', tampered)).toBe('not-listed');

    const opened = oaepDecrypt(vault, file(output, SEALED_MATERIAL_FILE));
    const recovered = await recoverKeyMaterial(manifest, [opened]);
    expect(recovered.equals(material)).toBe(true);
  });

  it('round-trips the manifest and renders a transcript without secrets', async () => {
    const material = generateKeyMaterial();
    const { manifest } = await runCeremony({
      material,
      organisationId: ORG_ID,
      kmsWrappingKey: kms.publicKey,
      escrowPublicKey: vault.publicKey,
      purpose: 'drill',
    });
    const bytes = serializeManifest(manifest);
    expect(parseManifest(bytes)).toEqual(manifest);
    expect(bytes.includes(material.toString('hex'))).toBe(false);
    expect(bytes.includes(material.toString('base64'))).toBe(false);

    const transcript = renderTranscript(manifest, sha256Hex(bytes));
    expect(transcript).toContain(sha256Hex(bytes));
    expect(transcript).toContain('DRILL');
    expect(transcript).not.toContain(material.toString('hex'));

    const broken = JSON.parse(bytes.toString('utf8')) as {
      escrow: { threshold: number };
    };
    broken.escrow.threshold = 2;
    expect(() => parseManifest(Buffer.from(JSON.stringify(broken)))).toThrow();
  });

  it('rejects an opened item from another package', async () => {
    const make = () =>
      runCeremony({
        material: generateKeyMaterial(),
        organisationId: ORG_ID,
        kmsWrappingKey: kms.publicKey,
        escrowPublicKey: vault.publicKey,
        purpose: 'escrow',
      });
    const [a, b] = await Promise.all([make(), make()]);
    const openedB = oaepDecrypt(vault, file(b, SEALED_MATERIAL_FILE));
    await expect(recoverKeyMaterial(a.manifest, [openedB])).rejects.toThrow(
      /does not belong/,
    );
  });
});

describe('ceremony: Shamir M-of-N escrow', () => {
  const custodians = ['Chairperson', 'Secretary', 'Elder A', 'Elder B', 'Treasurer'];
  const threshold = 3;
  let material: Buffer;
  let output: CeremonyOutput;
  let opened: Buffer[];

  beforeAll(async () => {
    material = generateKeyMaterial();
    output = await runCeremony({
      material,
      organisationId: ORG_ID,
      kmsWrappingKey: kms.publicKey,
      escrowPublicKey: vault.publicKey,
      purpose: 'escrow',
      custodians,
      threshold,
    });
    opened = custodians.map((_, i) =>
      oaepDecrypt(vault, file(output, custodianShareFile(i + 1))),
    );
  });

  it('records the split and seals one share per custodian', () => {
    const { manifest } = output;
    expect(manifest.escrow.scheme).toBe('shamir');
    expect(manifest.escrow.threshold).toBe(3);
    expect(manifest.escrow.sealed.map((s) => s.holder)).toEqual(custodians);
    expect(output.files.has(SEALED_MATERIAL_FILE)).toBe(false);
    for (const [name, bytes] of output.files) {
      expect(checkFile(manifest, name, bytes)).toBe('match');
    }
  });

  it('reconstructs with every set of M shares', async () => {
    const sets = combinations(opened, threshold);
    expect(sets).toHaveLength(10);
    for (const set of sets) {
      const recovered = await recoverKeyMaterial(output.manifest, set);
      expect(recovered.equals(material)).toBe(true);
    }
    const all = await recoverKeyMaterial(output.manifest, opened);
    expect(all.equals(material)).toBe(true);
  });

  it('fails with M-1 shares', async () => {
    for (const set of combinations(opened, threshold - 1)) {
      await expect(recoverKeyMaterial(output.manifest, set)).rejects.toThrow(
        /needs 3 distinct shares; got 2/,
      );
      // Even interpolated directly, M-1 shares do not yield the material.
      const shares = set.map((item) => new Uint8Array(item.subarray(20)));
      const guess = Buffer.from(await combine(shares));
      expect(guess.equals(material)).toBe(false);
      expect(keyCheckValue(guess)).not.toBe(output.manifest.keyMaterial.checkValue);
    }
  });

  it('does not count a repeated share twice', async () => {
    const [a, b] = opened;
    if (!a || !b) throw new Error('missing shares');
    await expect(recoverKeyMaterial(output.manifest, [a, b, a])).rejects.toThrow(/got 2/);
  });

  it('detects a corrupted share through the check value', async () => {
    const [a, b, c] = opened;
    if (!a || !b || !c) throw new Error('missing shares');
    const bad = Buffer.from(c);
    bad[25] = (bad[25] ?? 0) ^ 0xff;
    await expect(recoverKeyMaterial(output.manifest, [a, b, bad])).rejects.toThrow(
      /check value/,
    );
  });

  it('validates the split parameters', async () => {
    const base = {
      material: generateKeyMaterial(),
      organisationId: ORG_ID,
      kmsWrappingKey: kms.publicKey,
      escrowPublicKey: vault.publicKey,
      purpose: 'escrow' as const,
    };
    await expect(runCeremony({ ...base, threshold: 2 })).rejects.toThrow(/custodians/);
    await expect(
      runCeremony({ ...base, custodians: ['A', 'B'], threshold: 3 }),
    ).rejects.toThrow(/Threshold/);
    await expect(
      runCeremony({ ...base, custodians: ['A', 'B'], threshold: 1 }),
    ).rejects.toThrow(/Threshold/);
    await expect(
      runCeremony({ ...base, custodians: ['A', 'A'], threshold: 2 }),
    ).rejects.toThrow(/unique/);
    await expect(runCeremony({ ...base, custodians: ['A', 'B'] })).rejects.toThrow(
      /threshold/,
    );
    await expect(runCeremony({ ...base, organisationId: 'org-1' })).rejects.toThrow();
    await expect(runCeremony({ ...base, targetKeyArn: 'alias/x' })).rejects.toThrow(
      /ARN/,
    );
  });
});

describe('key-ceremony CLI', () => {
  const run = promisify(execFile);
  const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
  const cli = join(process.cwd(), 'scripts/key-ceremony.ts');
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'key-ceremony-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('generates, verifies and recovers a 2-of-3 drill package', async () => {
    const kmsPath = join(dir, 'wrapping.b64');
    const vaultPath = join(dir, 'escrow.pem');
    writeFileSync(
      kmsPath,
      kms.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    );
    writeFileSync(vaultPath, vault.publicKey.export({ format: 'pem', type: 'spki' }));
    const out = join(dir, 'ceremony');

    await run(tsx, [
      cli,
      'generate',
      '--organisation-id',
      ORG_ID,
      '--kms-wrapping-key',
      kmsPath,
      '--escrow-public-key',
      vaultPath,
      '--custodian',
      'Chairperson',
      '--custodian',
      'Elder A',
      '--custodian',
      'Elder B',
      '--threshold',
      '2',
      '--drill',
      '--out',
      out,
    ]);
    expect(readdirSync(out).sort()).toEqual(
      [
        IMPORT_FILE,
        MANIFEST_FILE,
        'ceremony-transcript.md',
        custodianShareFile(1),
        custodianShareFile(2),
        custodianShareFile(3),
      ].sort(),
    );
    const manifestPath = join(out, MANIFEST_FILE);
    const manifest = parseManifest(readFileSync(manifestPath));
    expect(manifest.purpose).toBe('drill');

    const verified = await run(tsx, [cli, 'verify', '--package', manifestPath]);
    expect(verified.stdout).toContain(sha256Hex(readFileSync(manifestPath)));
    expect(verified.stdout).not.toContain('mismatch');

    // The vault decrypts two custodian shares; the client makes a new key.
    const openedPaths = [1, 3].map((i) => {
      const path = join(dir, `opened-${i}.bin`);
      writeFileSync(
        path,
        oaepDecrypt(vault, readFileSync(join(out, custodianShareFile(i)))),
      );
      return path;
    });
    const newKms = rsaPair(3072);
    const newKmsPath = join(dir, 'new-wrapping.pem');
    writeFileSync(newKmsPath, newKms.publicKey.export({ format: 'pem', type: 'spki' }));
    const recoverOut = join(dir, 'recovered');
    await run(tsx, [
      cli,
      'recover',
      '--package',
      manifestPath,
      ...openedPaths.flatMap((p) => ['--opened', p]),
      '--kms-wrapping-key',
      newKmsPath,
      '--out',
      recoverOut,
    ]);
    const material = oaepDecrypt(newKms, readFileSync(join(recoverOut, IMPORT_FILE)));
    expect(keyCheckValue(material)).toBe(manifest.keyMaterial.checkValue);
    const report = JSON.parse(
      readFileSync(join(recoverOut, 'recovery-report.json'), 'utf8'),
    ) as { checkValueMatched: boolean };
    expect(report.checkValueMatched).toBe(true);

    // One share (M-1) is refused and writes nothing.
    const [firstOpened] = openedPaths;
    if (!firstOpened) throw new Error('missing share');
    await expect(
      run(tsx, [
        cli,
        'recover',
        '--package',
        manifestPath,
        '--opened',
        firstOpened,
        '--kms-wrapping-key',
        newKmsPath,
        '--out',
        join(dir, 'refused'),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('needs 2 distinct shares'),
    });
    expect(readdirSync(join(dir, 'refused'))).toEqual([]);
  }, 60_000);
});
