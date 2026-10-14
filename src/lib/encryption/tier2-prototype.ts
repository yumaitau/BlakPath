/**
 * Tier 2 client-side encryption — DESIGN SPIKE PROTOTYPE (#124).
 *
 * NOT WIRED INTO THE APP. Nothing imports this module outside its tests. It
 * exists to prove the key flows in `docs/adr/0002-tier2-client-side-encryption.md`
 * with the primitives a browser actually has, before any schema or UI work.
 *
 * Everything here runs on `globalThis.crypto.subtle` (WebCrypto) so the same
 * code runs in a browser and under Node in tests. No `node:crypto`, no
 * third-party crypto, no bespoke primitives: only ECDH P-256, HKDF-SHA-256,
 * PBKDF2-SHA-256 and AES-256-GCM, composed as follows.
 *
 *   staff unlock secret (WebAuthn PRF output, or a Tier 2 passphrase)
 *     -> staff KEK (AES-GCM, non-extractable)
 *        wraps the staff private key (ECDH P-256)
 *   org private key (ECDH P-256)
 *     sealed to each staff public key, and to the escrow public key (#123)
 *   note
 *     sealed to the org public key
 *
 * "Sealed to a public key" is ECIES-style: an ephemeral ECDH key pair, HKDF
 * over the shared secret (salted with both public keys), and AES-256-GCM with
 * additional authenticated data (AAD) that binds the ciphertext to its org,
 * purpose, record and key version. Moving a ciphertext to another record or
 * tenant fails authentication.
 *
 * The server only ever stores the serialised shapes below. None of them
 * contains plaintext or an unwrapped key.
 */

const subtle = globalThis.crypto.subtle;

export const TIER2_FORMAT_VERSION = 1;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const IV_BYTES = 12;
/** OWASP 2023 floor for PBKDF2-HMAC-SHA256. WebCrypto has no Argon2. */
export const MIN_PBKDF2_ITERATIONS = 600_000;

/** What a sealed blob protects. Closed set; part of the AAD and HKDF info. */
export type Tier2Purpose = 'genealogy_note' | 'org_key_for_staff';

// ---------------------------------------------------------------------------
// Encoding helpers (browser-safe; no Buffer)
// ---------------------------------------------------------------------------

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function randomIv(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

/**
 * Canonical AAD: fixed key order, UTF-8 JSON. Every field is metadata the
 * server already holds; none of it is secret or personal.
 */
function aad(fields: {
  org_id: string;
  purpose: Tier2Purpose;
  record_id: string;
  key_version: number;
}): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify({
      org_id: fields.org_id,
      purpose: fields.purpose,
      record_id: fields.record_id,
      key_version: fields.key_version,
      v: TIER2_FORMAT_VERSION,
    }),
  );
}

// ---------------------------------------------------------------------------
// Sealing to a public key (ECIES-style, WebCrypto only)
// ---------------------------------------------------------------------------

/** A ciphertext sealed to one recipient public key. All binary is base64. */
export interface SealedBox {
  v: typeof TIER2_FORMAT_VERSION;
  /** Ephemeral sender public key, raw uncompressed P-256 point. */
  epk: string;
  iv: string;
  /** AES-256-GCM ciphertext with the 16-byte tag appended (WebCrypto layout). */
  ct: string;
}

async function boxKey(
  shared: ArrayBuffer,
  epkRaw: Uint8Array,
  recipientRaw: Uint8Array,
  purpose: Tier2Purpose,
): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: concat(epkRaw, recipientRaw),
      info: utf8(`blakpath/tier2/v${TIER2_FORMAT_VERSION}/${purpose}`),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(
  recipient: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  purpose: Tier2Purpose,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<SealedBox> {
  const eph = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: recipient },
    eph.privateKey,
    256,
  );
  const epkRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const recipientRaw = new Uint8Array(await subtle.exportKey('raw', recipient));
  const key = await boxKey(shared, epkRaw, recipientRaw, purpose);
  const iv = randomIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    plaintext,
  );
  return { v: TIER2_FORMAT_VERSION, epk: toB64(epkRaw), iv: toB64(iv), ct: toB64(ct) };
}

async function open(
  recipientPrivate: CryptoKey,
  recipientPublic: CryptoKey,
  box: SealedBox,
  purpose: Tier2Purpose,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (box.v !== TIER2_FORMAT_VERSION) throw new Error('Unsupported Tier 2 format');
  const epkRaw = fromB64(box.epk);
  const epk = await subtle.importKey('raw', epkRaw, CURVE, false, []);
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: epk },
    recipientPrivate,
    256,
  );
  const recipientRaw = new Uint8Array(await subtle.exportKey('raw', recipientPublic));
  const key = await boxKey(shared, epkRaw, recipientRaw, purpose);
  // Throws OperationError on any tamper, wrong key or wrong AAD.
  return subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv), additionalData },
    key,
    fromB64(box.ct),
  );
}

// ---------------------------------------------------------------------------
// Staff keys
// ---------------------------------------------------------------------------

/**
 * Derive a staff key-encryption key from a WebAuthn PRF result (the 32-byte
 * `getClientExtensionResults().prf.results.first`). Each passkey yields a
 * different PRF output, so each enrolled passkey needs its own wrap.
 */
export async function deriveStaffKekFromPrf(
  prfOutput: Uint8Array<ArrayBuffer>,
  ids: { orgId: string; userId: string },
): Promise<CryptoKey> {
  if (prfOutput.length < 32) throw new Error('PRF output must be at least 32 bytes');
  const ikm = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8(ids.orgId),
      info: utf8(`blakpath/tier2/v${TIER2_FORMAT_VERSION}/staff-kek/${ids.userId}`),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Derive a staff key-encryption key from a Tier 2 passphrase. This must NOT be
 * the account password: the account password is sent to the server at sign-in.
 */
export async function deriveStaffKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = MIN_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be at least ${MIN_PBKDF2_ITERATIONS}`);
  }
  if (salt.length < 16) throw new Error('Passphrase salt must be at least 16 bytes');
  const ikm = await subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** What the server stores for one staff member. Public key is not secret. */
export interface StaffKeyRecord {
  orgId: string;
  userId: string;
  /** SPKI, base64. Shown as a fingerprint for out-of-band verification. */
  publicKey: string;
  /** PKCS#8 private key wrapped under the staff KEK with AES-GCM. */
  wrappedPrivateKey: { iv: string; data: string };
}

export interface StaffSession {
  userId: string;
  publicKey: CryptoKey;
  /** Non-extractable. Lives only in tab memory; never stored unwrapped. */
  privateKey: CryptoKey;
}

function staffWrapAad(orgId: string, userId: string) {
  return utf8(JSON.stringify({ org_id: orgId, purpose: 'staff_key', user_id: userId }));
}

/** Staff enrolment: create the staff key pair and wrap it under their KEK. */
export async function enrolStaff(
  ids: { orgId: string; userId: string },
  kek: CryptoKey,
): Promise<StaffKeyRecord> {
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const iv = randomIv();
  const wrapped = await subtle.wrapKey('pkcs8', pair.privateKey, kek, {
    name: 'AES-GCM',
    iv,
    additionalData: staffWrapAad(ids.orgId, ids.userId),
  });
  return {
    orgId: ids.orgId,
    userId: ids.userId,
    publicKey: toB64(await subtle.exportKey('spki', pair.publicKey)),
    wrappedPrivateKey: { iv: toB64(iv), data: toB64(wrapped) },
  };
}

export async function importStaffPublicKey(record: StaffKeyRecord): Promise<CryptoKey> {
  return subtle.importKey('spki', fromB64(record.publicKey), CURVE, true, []);
}

/** Unlock: unwrap the staff private key as non-extractable. Throws on a wrong KEK. */
export async function unlockStaff(
  record: StaffKeyRecord,
  kek: CryptoKey,
): Promise<StaffSession> {
  const privateKey = await subtle.unwrapKey(
    'pkcs8',
    fromB64(record.wrappedPrivateKey.data),
    kek,
    {
      name: 'AES-GCM',
      iv: fromB64(record.wrappedPrivateKey.iv),
      additionalData: staffWrapAad(record.orgId, record.userId),
    },
    CURVE,
    false,
    ['deriveBits'],
  );
  return {
    userId: record.userId,
    publicKey: await importStaffPublicKey(record),
    privateKey,
  };
}

/** SHA-256 of the SPKI, hex. Compared out of band before granting access. */
export async function publicKeyFingerprint(spkiB64: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', fromB64(spkiB64));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
}

// ---------------------------------------------------------------------------
// Organisation key
// ---------------------------------------------------------------------------

export interface OrgPublicKeyRecord {
  orgId: string;
  version: number;
  publicKey: string; // SPKI, base64
}

/** The org private key sealed to one staff member (or, later, the escrow key). */
export interface OrgKeyGrant {
  orgId: string;
  version: number;
  userId: string;
  box: SealedBox;
}

export interface OrgKey {
  orgId: string;
  version: number;
  publicKey: CryptoKey;
  /**
   * Extractable only when opened for an admin flow (joiner, rotation, escrow
   * deposit). A normal read session opens it non-extractable.
   */
  privateKey: CryptoKey;
}

function grantAad(orgId: string, version: number, userId: string) {
  return aad({
    org_id: orgId,
    purpose: 'org_key_for_staff',
    record_id: userId,
    key_version: version,
  });
}

export async function createOrgKey(orgId: string, version: number): Promise<OrgKey> {
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits']);
  return { orgId, version, publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function exportOrgPublicKey(key: OrgKey): Promise<OrgPublicKeyRecord> {
  return {
    orgId: key.orgId,
    version: key.version,
    publicKey: toB64(await subtle.exportKey('spki', key.publicKey)),
  };
}

export async function importOrgPublicKey(record: OrgPublicKeyRecord): Promise<CryptoKey> {
  return subtle.importKey('spki', fromB64(record.publicKey), CURVE, true, []);
}

/** Seal the org private key to a staff public key (joiner, rotation). */
export async function grantOrgKey(
  orgKey: OrgKey,
  staff: StaffKeyRecord,
): Promise<OrgKeyGrant> {
  if (staff.orgId !== orgKey.orgId)
    throw new Error('Staff key belongs to another organisation');
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', orgKey.privateKey));
  try {
    const box = await seal(
      await importStaffPublicKey(staff),
      pkcs8,
      'org_key_for_staff',
      grantAad(orgKey.orgId, orgKey.version, staff.userId),
    );
    return { orgId: orgKey.orgId, version: orgKey.version, userId: staff.userId, box };
  } finally {
    pkcs8.fill(0); // hygiene only; not a memory-safety boundary
  }
}

/** Open the org private key from a grant addressed to this staff session. */
export async function openOrgKey(
  grant: OrgKeyGrant,
  session: StaffSession,
  orgPublic: OrgPublicKeyRecord,
  opts: { extractable?: boolean } = {},
): Promise<OrgKey> {
  if (grant.userId !== session.userId)
    throw new Error('Grant is for another staff member');
  if (orgPublic.version !== grant.version || orgPublic.orgId !== grant.orgId) {
    throw new Error('Grant does not match the current organisation key');
  }
  const pkcs8 = new Uint8Array(
    await open(
      session.privateKey,
      session.publicKey,
      grant.box,
      'org_key_for_staff',
      grantAad(grant.orgId, grant.version, grant.userId),
    ),
  );
  try {
    const privateKey = await subtle.importKey(
      'pkcs8',
      pkcs8,
      CURVE,
      opts.extractable ?? false,
      ['deriveBits'],
    );
    return {
      orgId: grant.orgId,
      version: grant.version,
      publicKey: await importOrgPublicKey(orgPublic),
      privateKey,
    };
  } finally {
    pkcs8.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Genealogy notes
// ---------------------------------------------------------------------------

/** What the server stores in place of a genealogy note's text. */
export interface SealedNote {
  orgId: string;
  recordId: string;
  keyVersion: number;
  box: SealedBox;
}

function noteAad(orgId: string, recordId: string, keyVersion: number) {
  return aad({
    org_id: orgId,
    purpose: 'genealogy_note',
    record_id: recordId,
    key_version: keyVersion,
  });
}

/** Encrypt a note in the browser. Only the org public key is needed to write. */
export async function sealNote(
  orgPublic: OrgPublicKeyRecord,
  recordId: string,
  text: string,
): Promise<SealedNote> {
  const box = await seal(
    await importOrgPublicKey(orgPublic),
    utf8(text),
    'genealogy_note',
    noteAad(orgPublic.orgId, recordId, orgPublic.version),
  );
  return { orgId: orgPublic.orgId, recordId, keyVersion: orgPublic.version, box };
}

export async function openNote(note: SealedNote, orgKey: OrgKey): Promise<string> {
  if (note.orgId !== orgKey.orgId || note.keyVersion !== orgKey.version) {
    throw new Error('Note is sealed under a different organisation key');
  }
  const plain = await open(
    orgKey.privateKey,
    orgKey.publicKey,
    note.box,
    'genealogy_note',
    noteAad(note.orgId, note.recordId, note.keyVersion),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

// ---------------------------------------------------------------------------
// Leaver: revoke and rotate
// ---------------------------------------------------------------------------

export interface RotationResult {
  orgPublic: OrgPublicKeyRecord;
  grants: OrgKeyGrant[];
  notes: SealedNote[];
}

/**
 * Leaver revocation, run in a remaining admin's browser.
 *
 * Deleting the leaver's grant alone is not revocation: the leaver may have kept
 * the org private key. So: mint org key v+1, grant it only to the remaining
 * staff, and re-seal every note under v+1 with a fresh ephemeral key. The
 * caller then replaces the server's v grants and notes with these and deletes
 * the old ones. The leaver's retained v key opens nothing the server holds
 * after that. It still opens any v ciphertext the leaver copied before they
 * left; no cryptography can take back what someone has already read.
 */
export async function rotateOrgKey(
  current: OrgKey,
  remainingStaff: StaffKeyRecord[],
  notes: SealedNote[],
): Promise<RotationResult> {
  const next = await createOrgKey(current.orgId, current.version + 1);
  const orgPublic = await exportOrgPublicKey(next);
  const grants = await Promise.all(remainingStaff.map((s) => grantOrgKey(next, s)));
  const resealed = await Promise.all(
    notes.map(async (n) => sealNote(orgPublic, n.recordId, await openNote(n, current))),
  );
  return { orgPublic, grants, notes: resealed };
}
