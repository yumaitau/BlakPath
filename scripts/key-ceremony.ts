/**
 * Offline key ceremony CLI for imported (Origin=EXTERNAL) tenant keys.
 *
 * Run on the offline ceremony machine. It needs no network, no AWS credentials
 * and no database. Plaintext key material stays in memory and is never written
 * to disk. Procedure: docs/key-escrow-runbook.md.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  IMPORT_FILE,
  MANIFEST_FILE,
  checkFile,
  parseManifest,
  recoverKeyMaterial,
  runCeremony,
  serializeManifest,
} from '@/lib/key-ceremony/escrow';
import {
  generateKeyMaterial,
  loadRsaPublicKey,
  publicKeyFingerprint,
  rsaOaepSha256Encrypt,
  sha256Hex,
} from '@/lib/key-ceremony/primitives';
import { renderTranscript } from '@/lib/key-ceremony/transcript';

const USAGE = `Usage: pnpm key-ceremony <command> [options]

generate   Generate 256-bit key material, wrap it for KMS import and build the
           escrow package.
  --organisation-id <uuid>      Tenant organisation id
  --kms-wrapping-key <file>     PublicKey from GetParametersForImport
                                (RSAES_OAEP_SHA_256, RSA_3072 or RSA_4096)
  --escrow-public-key <file>    Published escrow vault public key
  --target-key-arn <arn>        Client KMS key the material is imported into
  --custodian <label>           Repeat per custodian to split M-of-N (Shamir)
  --threshold <M>               Shares needed to recover (with --custodian)
  --drill                       Mark as a synthetic drill key
  --out <dir>                   New or empty output directory

verify     Check ceremony files against escrow-package.json (no secrets needed).
  --package <file>              escrow-package.json
  --file <file>                 Extra file to check (repeatable), e.g. a share

recover    Rebuild material from items the vault decrypted and wrap it for
           import into a NEW client KMS key.
  --package <file>              escrow-package.json
  --opened <file>               Raw KMS Decrypt plaintext (repeatable)
  --kms-wrapping-key <file>     PublicKey from GetParametersForImport for the new key
  --out <dir>                   New or empty output directory
`;

function required(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`);
  return value;
}

function prepareOutDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (readdirSync(dir).length > 0)
    throw new Error(`Output directory ${dir} is not empty`);
}

function writeNew(dir: string, name: string, bytes: Buffer | string): void {
  writeFileSync(join(dir, name), bytes, { flag: 'wx', mode: 0o600 });
}

async function generate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'organisation-id': { type: 'string' },
      'kms-wrapping-key': { type: 'string' },
      'escrow-public-key': { type: 'string' },
      'target-key-arn': { type: 'string' },
      custodian: { type: 'string', multiple: true },
      threshold: { type: 'string' },
      drill: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const out = required(values, 'out');
  const kmsWrappingKey = loadRsaPublicKey(
    readFileSync(required(values, 'kms-wrapping-key')),
    'KMS wrapping key',
  );
  const escrowPublicKey = loadRsaPublicKey(
    readFileSync(required(values, 'escrow-public-key')),
    'Escrow public key',
  );
  const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
  prepareOutDir(out);

  const material = generateKeyMaterial();
  try {
    const { manifest, files } = await runCeremony({
      material,
      organisationId: required(values, 'organisation-id'),
      kmsWrappingKey,
      escrowPublicKey,
      purpose: values.drill ? 'drill' : 'escrow',
      ...(values['target-key-arn'] ? { targetKeyArn: values['target-key-arn'] } : {}),
      ...(values.custodian ? { custodians: values.custodian } : {}),
      ...(threshold === undefined ? {} : { threshold }),
    });
    const manifestBytes = serializeManifest(manifest);
    const digest = sha256Hex(manifestBytes);
    for (const [name, bytes] of files) writeNew(out, name, bytes);
    writeNew(out, MANIFEST_FILE, manifestBytes);
    writeNew(out, 'ceremony-transcript.md', renderTranscript(manifest, digest));

    console.info(`Package id:        ${manifest.packageId}`);
    console.info(`Package digest:    ${digest}`);
    console.info(`Key check value:   ${manifest.keyMaterial.checkValue}`);
    console.info(`Escrow key SHA-256: ${manifest.escrow.escrowPublicKeySha256}`);
    console.info(`Wrote ${files.size + 2} files to ${out}`);
  } finally {
    material.fill(0);
  }
}

function verify(args: string[]): void {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      package: { type: 'string' },
      file: { type: 'string', multiple: true },
    },
  });
  const packagePath = required(values, 'package');
  const manifestBytes = readFileSync(packagePath);
  const manifest = parseManifest(manifestBytes);
  console.info(`Package id:     ${manifest.packageId}`);
  console.info(`Package digest: ${sha256Hex(manifestBytes)}`);

  const dir = dirname(packagePath);
  const present = new Set(readdirSync(dir));
  const candidates = new Map<string, string>();
  for (const name of [
    manifest.kmsImport.file,
    ...manifest.escrow.sealed.map((s) => s.file),
  ]) {
    if (present.has(name)) candidates.set(name, join(dir, name));
  }
  for (const path of values.file ?? []) candidates.set(basename(path), path);

  let failed = false;
  for (const [name, path] of candidates) {
    const result = checkFile(manifest, name, readFileSync(path));
    if (result !== 'match') failed = true;
    console.info(`${result.padEnd(10)} ${name}`);
  }
  for (const sealed of manifest.escrow.sealed) {
    if (!candidates.has(sealed.file)) {
      console.info(`${'absent'.padEnd(10)} ${sealed.file} (held by ${sealed.holder})`);
    }
  }
  if (failed) {
    console.error('Verification failed.');
    process.exitCode = 1;
  }
}

async function recover(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      package: { type: 'string' },
      opened: { type: 'string', multiple: true },
      'kms-wrapping-key': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const manifest = parseManifest(readFileSync(required(values, 'package')));
  const wrappingKey = loadRsaPublicKey(
    readFileSync(required(values, 'kms-wrapping-key')),
    'KMS wrapping key',
  );
  const out = required(values, 'out');
  const opened = (values.opened ?? []).map((path) => readFileSync(path));
  prepareOutDir(out);

  const material = await recoverKeyMaterial(manifest, opened);
  try {
    const wrapped = rsaOaepSha256Encrypt(wrappingKey, material);
    writeNew(out, IMPORT_FILE, wrapped);
    const report = {
      packageId: manifest.packageId,
      organisationId: manifest.organisationId,
      purpose: manifest.purpose,
      checkValue: manifest.keyMaterial.checkValue,
      checkValueMatched: true,
      itemsUsed: opened.length,
      wrappingPublicKeySha256: publicKeyFingerprint(wrappingKey),
      encryptedKeyMaterialSha256: sha256Hex(wrapped),
      recoveredAt: new Date().toISOString(),
    };
    writeNew(out, 'recovery-report.json', `${JSON.stringify(report, null, 2)}\n`);
    console.info(`Check value matched for package ${manifest.packageId}.`);
    console.info(`Wrote ${IMPORT_FILE} and recovery-report.json to ${out}`);
  } finally {
    material.fill(0);
    for (const item of opened) item.fill(0);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'generate':
      return generate(rest);
    case 'verify':
      return verify(rest);
    case 'recover':
      return recover(rest);
    default:
      console.info(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
