import { randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto';
import { combine, split } from 'shamir-secret-sharing';
import { z } from 'zod';
import { parseKeyArn } from '@/lib/encryption/key-provider';
import {
  KEY_MATERIAL_BYTES,
  RSA_OAEP_SHA256,
  keyCheckValue,
  publicKeyFingerprint,
  rsaOaepSha256Encrypt,
  sha256Hex,
} from './primitives';

/**
 * Escrow package for imported (Origin=EXTERNAL) key material.
 *
 * - `whole`: the material is sealed to the escrow public key (an RSA key that
 *   lives in the escrow vault's KMS and only decrypts there). The sealed file
 *   is deposited in the vault.
 * - `shamir`: the material is split M-of-N over GF(256) and each share is
 *   sealed to the escrow public key. Each custodian keeps one sealed share;
 *   the vault keeps only this manifest. Recovery needs M custodians AND the
 *   vault's dual-controlled decrypt, so neither side can recover alone.
 *
 * Shamir uses `shamir-secret-sharing` (Privy; zero dependencies; audited by
 * Cure53 and Zellic) instead of an in-repo implementation. Shares carry no
 * integrity of their own, so recovery always checks the key check value.
 *
 * Sealed plaintext framing: "BPEK" || packageId (16 bytes) || payload. It ties
 * every sealed item to one package; it is a label, not a cipher.
 */

export const MANIFEST_FILE = 'escrow-package.json';
export const IMPORT_FILE = 'EncryptedKeyMaterial.bin';
export const SEALED_MATERIAL_FILE = 'escrow-sealed-material.bin';

const MAGIC = Buffer.from('BPEK', 'ascii');
const HEADER_BYTES = MAGIC.length + 16;
/** shamir-secret-sharing appends a one-byte x coordinate to each share. */
const SHARE_BYTES = KEY_MATERIAL_BYTES + 1;
const MAX_SHARES = 255;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const manifestSchema = z.object({
  format: z.literal('blakpath-escrow-package'),
  version: z.literal(1),
  packageId: z.uuid(),
  createdAt: z.iso.datetime(),
  purpose: z.enum(['escrow', 'drill']),
  organisationId: z.uuid(),
  targetKeyArn: z.string().nullable(),
  keyMaterial: z.object({
    bytes: z.literal(KEY_MATERIAL_BYTES),
    checkValue: hex64,
  }),
  kmsImport: z.object({
    wrappingAlgorithm: z.literal(RSA_OAEP_SHA256),
    wrappingPublicKeySha256: hex64,
    file: z.literal(IMPORT_FILE),
    sha256: hex64,
  }),
  escrow: z.object({
    algorithm: z.literal(RSA_OAEP_SHA256),
    escrowPublicKeySha256: hex64,
    scheme: z.enum(['whole', 'shamir']),
    threshold: z.number().int().min(1).max(MAX_SHARES),
    sealed: z
      .array(
        z.object({
          index: z.number().int().min(1).max(MAX_SHARES),
          holder: z.string().min(1),
          file: z.string().regex(/^[a-z0-9-]+\.bin$/),
          sha256: hex64,
        }),
      )
      .min(1)
      .max(MAX_SHARES),
  }),
});

export type EscrowManifest = z.infer<typeof manifestSchema>;
export type CeremonyPurpose = EscrowManifest['purpose'];

export interface CeremonyInput {
  readonly material: Uint8Array;
  readonly organisationId: string;
  /** Public key from KMS GetParametersForImport (RSAES_OAEP_SHA_256). */
  readonly kmsWrappingKey: KeyObject;
  /** Public half of the escrow vault's RSA KMS key. */
  readonly escrowPublicKey: KeyObject;
  readonly purpose: CeremonyPurpose;
  readonly targetKeyArn?: string;
  /** Custodian labels (role titles, not personal details). Enables Shamir. */
  readonly custodians?: readonly string[];
  readonly threshold?: number;
  readonly now?: Date;
}

export interface CeremonyOutput {
  readonly manifest: EscrowManifest;
  /** File name to bytes: the KMS import file and every sealed item. */
  readonly files: ReadonlyMap<string, Buffer>;
}

export function custodianShareFile(index: number): string {
  return `custodian-share-${String(index).padStart(2, '0')}.bin`;
}

function packageIdBytes(packageId: string): Buffer {
  return Buffer.from(packageId.replace(/-/g, ''), 'hex');
}

function frame(packageId: string, payload: Uint8Array): Buffer {
  return Buffer.concat([MAGIC, packageIdBytes(packageId), payload]);
}

function validateSplit(
  custodians: readonly string[] | undefined,
  threshold: number | undefined,
): { custodians: string[]; threshold: number } | null {
  if (!custodians || custodians.length === 0) {
    if (threshold !== undefined) throw new Error('A threshold needs custodians');
    return null;
  }
  const labels = custodians.map((c) => c.trim());
  if (labels.some((l) => !l)) throw new Error('Custodian labels must not be empty');
  if (new Set(labels).size !== labels.length) {
    throw new Error('Custodian labels must be unique');
  }
  if (labels.length < 2 || labels.length > MAX_SHARES) {
    throw new Error(`A split needs between 2 and ${MAX_SHARES} custodians`);
  }
  if (threshold === undefined) throw new Error('A split needs a threshold (M of N)');
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > labels.length) {
    throw new Error(`Threshold must be an integer from 2 to ${labels.length}`);
  }
  return { custodians: labels, threshold };
}

/**
 * Wrap the material for KMS import and build the escrow package. The caller
 * owns `material` and zeroes it afterwards. Plaintext is never returned.
 */
export async function runCeremony(input: CeremonyInput): Promise<CeremonyOutput> {
  if (input.material.length !== KEY_MATERIAL_BYTES) {
    throw new Error(`Key material must be ${KEY_MATERIAL_BYTES} bytes`);
  }
  z.uuid().parse(input.organisationId);
  if (input.targetKeyArn) parseKeyArn(input.targetKeyArn);
  const plan = validateSplit(input.custodians, input.threshold);

  const packageId = randomUUID();
  const files = new Map<string, Buffer>();
  const importBlob = rsaOaepSha256Encrypt(input.kmsWrappingKey, input.material);
  files.set(IMPORT_FILE, importBlob);

  const sealed: EscrowManifest['escrow']['sealed'] = [];
  if (plan) {
    const shares = await split(
      Uint8Array.from(input.material),
      plan.custodians.length,
      plan.threshold,
    );
    shares.forEach((share, i) => {
      const framed = frame(packageId, share);
      const blob = rsaOaepSha256Encrypt(input.escrowPublicKey, framed);
      framed.fill(0);
      share.fill(0);
      const file = custodianShareFile(i + 1);
      files.set(file, blob);
      sealed.push({
        index: i + 1,
        holder: plan.custodians[i] ?? '',
        file,
        sha256: sha256Hex(blob),
      });
    });
  } else {
    const framed = frame(packageId, input.material);
    const blob = rsaOaepSha256Encrypt(input.escrowPublicKey, framed);
    framed.fill(0);
    files.set(SEALED_MATERIAL_FILE, blob);
    sealed.push({
      index: 1,
      holder: 'escrow-vault',
      file: SEALED_MATERIAL_FILE,
      sha256: sha256Hex(blob),
    });
  }

  const manifest: EscrowManifest = {
    format: 'blakpath-escrow-package',
    version: 1,
    packageId,
    createdAt: (input.now ?? new Date()).toISOString(),
    purpose: input.purpose,
    organisationId: input.organisationId,
    targetKeyArn: input.targetKeyArn ?? null,
    keyMaterial: { bytes: KEY_MATERIAL_BYTES, checkValue: keyCheckValue(input.material) },
    kmsImport: {
      wrappingAlgorithm: RSA_OAEP_SHA256,
      wrappingPublicKeySha256: publicKeyFingerprint(input.kmsWrappingKey),
      file: IMPORT_FILE,
      sha256: sha256Hex(importBlob),
    },
    escrow: {
      algorithm: RSA_OAEP_SHA256,
      escrowPublicKeySha256: publicKeyFingerprint(input.escrowPublicKey),
      scheme: plan ? 'shamir' : 'whole',
      threshold: plan?.threshold ?? 1,
      sealed,
    },
  };
  return { manifest, files };
}

/** Stable bytes for the manifest file; its SHA-256 is the package digest. */
export function serializeManifest(manifest: EscrowManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function parseManifest(bytes: Buffer): EscrowManifest {
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const { scheme, threshold, sealed } = manifest.escrow;
  if (scheme === 'whole' && (threshold !== 1 || sealed.length !== 1)) {
    throw new Error('A whole-material package has exactly one sealed item');
  }
  if (scheme === 'shamir' && (threshold < 2 || threshold > sealed.length)) {
    throw new Error('Shamir threshold is outside 2..N');
  }
  return manifest;
}

export type FileCheck = 'match' | 'mismatch' | 'not-listed';

/** Compare one ceremony file against the manifest's SHA-256. */
export function checkFile(
  manifest: EscrowManifest,
  name: string,
  bytes: Buffer,
): FileCheck {
  const expected =
    name === manifest.kmsImport.file
      ? manifest.kmsImport.sha256
      : manifest.escrow.sealed.find((s) => s.file === name)?.sha256;
  if (!expected) return 'not-listed';
  return sha256Hex(bytes) === expected ? 'match' : 'mismatch';
}

function unframe(manifest: EscrowManifest, opened: Uint8Array): Buffer {
  const bytes = Buffer.from(opened);
  const expectedLength =
    HEADER_BYTES +
    (manifest.escrow.scheme === 'shamir' ? SHARE_BYTES : KEY_MATERIAL_BYTES);
  if (
    bytes.length !== expectedLength ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    !bytes.subarray(MAGIC.length, HEADER_BYTES).equals(packageIdBytes(manifest.packageId))
  ) {
    throw new Error('Opened item does not belong to this escrow package');
  }
  return bytes.subarray(HEADER_BYTES);
}

function checkValueMatches(manifest: EscrowManifest, material: Uint8Array): boolean {
  return timingSafeEqual(
    Buffer.from(keyCheckValue(material), 'hex'),
    Buffer.from(manifest.keyMaterial.checkValue, 'hex'),
  );
}

/**
 * Rebuild the material from items the vault decrypted (KMS Decrypt with the
 * escrow key). Throws unless the result matches the manifest's check value.
 * The caller zeroes the returned buffer.
 */
export async function recoverKeyMaterial(
  manifest: EscrowManifest,
  opened: readonly Uint8Array[],
): Promise<Buffer> {
  const payloads = opened.map((item) => unframe(manifest, item));
  let material: Buffer;
  if (manifest.escrow.scheme === 'whole') {
    const first = payloads[0];
    if (!first) throw new Error('No opened escrow item was supplied');
    material = Buffer.from(first);
  } else {
    const byX = new Map<number, Uint8Array>();
    for (const share of payloads) byX.set(share[share.length - 1] ?? 0, share);
    const distinct = [...byX.values()];
    if (distinct.length < manifest.escrow.threshold) {
      throw new Error(
        `Recovery needs ${manifest.escrow.threshold} distinct shares; got ${distinct.length}`,
      );
    }
    // The library accepts plain Uint8Array only, not Buffer.
    const shares = distinct.map((share) => new Uint8Array(share));
    const combined = await combine(shares);
    material = Buffer.from(combined);
    combined.fill(0);
    for (const share of shares) share.fill(0);
  }
  for (const payload of payloads) payload.fill(0);
  if (material.length !== KEY_MATERIAL_BYTES || !checkValueMatches(manifest, material)) {
    material.fill(0);
    throw new Error('Recovered material does not match the package check value');
  }
  return material;
}
