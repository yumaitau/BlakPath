import { describe, expect, it } from 'vitest';
import {
  MIN_PBKDF2_ITERATIONS,
  createOrgKey,
  deriveStaffKekFromPassphrase,
  deriveStaffKekFromPrf,
  enrolStaff,
  exportOrgPublicKey,
  grantOrgKey,
  openNote,
  openOrgKey,
  publicKeyFingerprint,
  rotateOrgKey,
  sealNote,
  unlockStaff,
  type OrgKeyGrant,
  type SealedNote,
  type StaffKeyRecord,
} from '@/lib/encryption/tier2-prototype';

/**
 * Tier 2 design-spike prototype (#124). Proves, with WebCrypto only, that a
 * genealogy note written by one staff member can be read by another, that the
 * server-side shapes hold no plaintext, and that a leaver loses access after
 * rotation. The prototype is not wired into the app.
 */

const ORG = '0192a6f0-0000-7000-8000-000000000001';
const OTHER_ORG = '0192a6f0-0000-7000-8000-000000000002';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';
const RECORD = 'family-link-1';
const NOTE =
  'Aunty told us her grandmother was born at the old mission in 1931 (fictional test text).';

const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * Alice unlocks with a passkey (WebAuthn PRF output, simulated as 32 random
 * bytes). Bob unlocks with a Tier 2 passphrase. Both receive grants of org key
 * v1 from the founding admin flow.
 */
async function setup() {
  const alicePrf = random(32);
  const aliceKek = await deriveStaffKekFromPrf(alicePrf, { orgId: ORG, userId: ALICE });
  const alice = await enrolStaff({ orgId: ORG, userId: ALICE }, aliceKek);

  const bobSalt = random(16);
  const bobKek = await deriveStaffKekFromPassphrase(
    'correct horse battery staple',
    bobSalt,
  );
  const bob = await enrolStaff({ orgId: ORG, userId: BOB }, bobKek);

  const orgKey = await createOrgKey(ORG, 1);
  const orgPublic = await exportOrgPublicKey(orgKey);
  const grants: Record<string, OrgKeyGrant> = {
    [ALICE]: await grantOrgKey(orgKey, alice),
    [BOB]: await grantOrgKey(orgKey, bob),
  };
  return { alicePrf, aliceKek, alice, bobSalt, bobKek, bob, orgKey, orgPublic, grants };
}

async function readAs(
  record: StaffKeyRecord,
  kek: CryptoKey,
  grant: OrgKeyGrant,
  orgPublic: Awaited<ReturnType<typeof exportOrgPublicKey>>,
  note: SealedNote,
) {
  const session = await unlockStaff(record, kek);
  const orgKey = await openOrgKey(grant, session, orgPublic);
  return openNote(note, orgKey);
}

describe('Tier 2 prototype: genealogy note across two staff', () => {
  it('lets a note written by one staff member be read by another', async () => {
    const s = await setup();

    // Alice writes. Writing needs only the org public key.
    const note = await sealNote(s.orgPublic, RECORD, NOTE);

    // Both read in their own "browser" with their own unlock secret.
    expect(await readAs(s.alice, s.aliceKek, s.grants[ALICE]!, s.orgPublic, note)).toBe(
      NOTE,
    );
    expect(await readAs(s.bob, s.bobKek, s.grants[BOB]!, s.orgPublic, note)).toBe(NOTE);
  });

  it('stores nothing the server could read', async () => {
    const s = await setup();
    const note = await sealNote(s.orgPublic, RECORD, NOTE);
    const serverState = JSON.stringify({
      staff: [s.alice, s.bob],
      orgPublic: s.orgPublic,
      grants: s.grants,
      notes: [note],
    });
    expect(serverState).not.toContain('old mission');
    expect(serverState).not.toContain('correct horse');
    // Sealing is randomised: the same text never produces the same ciphertext.
    const again = await sealNote(s.orgPublic, RECORD, NOTE);
    expect(again.box.ct).not.toBe(note.box.ct);
    expect(again.box.epk).not.toBe(note.box.epk);
  });

  it('keeps unlocked private keys non-extractable in a read session', async () => {
    const s = await setup();
    const session = await unlockStaff(s.alice, s.aliceKek);
    expect(session.privateKey.extractable).toBe(false);
    const orgKey = await openOrgKey(s.grants[ALICE]!, session, s.orgPublic);
    expect(orgKey.privateKey.extractable).toBe(false);
    // An admin flow must ask for an extractable key explicitly.
    const adminKey = await openOrgKey(s.grants[ALICE]!, session, s.orgPublic, {
      extractable: true,
    });
    expect(adminKey.privateKey.extractable).toBe(true);
  });

  it('rejects a wrong passphrase or a wrong passkey', async () => {
    const s = await setup();
    const wrongPass = await deriveStaffKekFromPassphrase('wrong', s.bobSalt);
    await expect(unlockStaff(s.bob, wrongPass)).rejects.toThrow();
    const wrongPrf = await deriveStaffKekFromPrf(random(32), {
      orgId: ORG,
      userId: ALICE,
    });
    await expect(unlockStaff(s.alice, wrongPrf)).rejects.toThrow();
    // A staff record replayed under another user id fails the wrap AAD.
    await expect(unlockStaff({ ...s.alice, userId: BOB }, s.aliceKek)).rejects.toThrow();
  });

  it('refuses a passphrase KDF below the iteration floor', async () => {
    await expect(
      deriveStaffKekFromPassphrase('x', random(16), MIN_PBKDF2_ITERATIONS - 1),
    ).rejects.toThrow(/iterations/);
    await expect(deriveStaffKekFromPassphrase('x', random(8))).rejects.toThrow(/salt/);
  });

  it('binds a sealed note to its record, organisation and key version', async () => {
    const s = await setup();
    const note = await sealNote(s.orgPublic, RECORD, NOTE);
    const session = await unlockStaff(s.alice, s.aliceKek);
    const orgKey = await openOrgKey(s.grants[ALICE]!, session, s.orgPublic);

    // Moved to another row: GCM authentication fails.
    await expect(
      openNote({ ...note, recordId: 'family-link-2' }, orgKey),
    ).rejects.toThrow();
    // Relabelled as another tenant or version: refused before decrypting.
    await expect(openNote({ ...note, orgId: OTHER_ORG }, orgKey)).rejects.toThrow();
    await expect(openNote({ ...note, keyVersion: 2 }, orgKey)).rejects.toThrow();

    // Tampered ciphertext.
    const ct = note.box.ct;
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(
      openNote({ ...note, box: { ...note.box, ct: flipped } }, orgKey),
    ).rejects.toThrow();
  });

  it('will not open a grant addressed to someone else', async () => {
    const s = await setup();
    const bobSession = await unlockStaff(s.bob, s.bobKek);
    await expect(openOrgKey(s.grants[ALICE]!, bobSession, s.orgPublic)).rejects.toThrow();
    // Re-labelling Alice's grant as Bob's fails the grant AAD.
    await expect(
      openOrgKey({ ...s.grants[ALICE]!, userId: BOB }, bobSession, s.orgPublic),
    ).rejects.toThrow();
  });

  it('refuses to grant the org key to another organisation’s staff key', async () => {
    const s = await setup();
    const kek = await deriveStaffKekFromPrf(random(32), {
      orgId: OTHER_ORG,
      userId: CAROL,
    });
    const outsider = await enrolStaff({ orgId: OTHER_ORG, userId: CAROL }, kek);
    await expect(grantOrgKey(s.orgKey, outsider)).rejects.toThrow(/another organisation/);
  });
});

describe('Tier 2 prototype: joiner and leaver', () => {
  it('lets an existing staff member grant access to a joiner', async () => {
    const s = await setup();
    const note = await sealNote(s.orgPublic, RECORD, NOTE);

    const carolKek = await deriveStaffKekFromPrf(random(32), {
      orgId: ORG,
      userId: CAROL,
    });
    const carol = await enrolStaff({ orgId: ORG, userId: CAROL }, carolKek);

    // Alice compares Carol's fingerprint out of band before granting.
    const fp = await publicKeyFingerprint(carol.publicKey);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);

    const aliceSession = await unlockStaff(s.alice, s.aliceKek);
    const adminKey = await openOrgKey(s.grants[ALICE]!, aliceSession, s.orgPublic, {
      extractable: true,
    });
    const carolGrant = await grantOrgKey(adminKey, carol);

    expect(await readAs(carol, carolKek, carolGrant, s.orgPublic, note)).toBe(NOTE);
  });

  it('revokes a leaver: after rotation their retained key opens nothing', async () => {
    const s = await setup();
    const before = await sealNote(s.orgPublic, RECORD, NOTE);

    // Worst case: Bob, before leaving, kept his unlocked v1 org private key.
    const bobSession = await unlockStaff(s.bob, s.bobKek);
    const bobRetainedV1 = await openOrgKey(s.grants[BOB]!, bobSession, s.orgPublic);
    expect(await openNote(before, bobRetainedV1)).toBe(NOTE);

    // Alice runs the leaver flow: rotate to v2 for remaining staff only.
    const aliceSession = await unlockStaff(s.alice, s.aliceKek);
    const aliceV1 = await openOrgKey(s.grants[ALICE]!, aliceSession, s.orgPublic, {
      extractable: true,
    });
    const rotated = await rotateOrgKey(aliceV1, [s.alice], [before]);

    expect(rotated.orgPublic.version).toBe(2);
    expect(rotated.grants.map((g) => g.userId)).toEqual([ALICE]);
    const [resealed] = rotated.notes;
    expect(resealed!.keyVersion).toBe(2);
    expect(resealed!.box.ct).not.toBe(before.box.ct);

    // Alice still reads under v2.
    const aliceGrantV2 = rotated.grants[0]!;
    expect(
      await readAs(s.alice, s.aliceKek, aliceGrantV2, rotated.orgPublic, resealed!),
    ).toBe(NOTE);

    // Bob has no v2 grant, and his old v1 grant does not match the v2 key.
    expect(rotated.grants.some((g) => g.userId === BOB)).toBe(false);
    await expect(
      openOrgKey(s.grants[BOB]!, bobSession, rotated.orgPublic),
    ).rejects.toThrow();

    // His retained v1 key does not open the resealed note, even relabelled.
    await expect(openNote(resealed!, bobRetainedV1)).rejects.toThrow();
    await expect(
      openNote({ ...resealed!, keyVersion: 1 }, bobRetainedV1),
    ).rejects.toThrow();

    // Nor anything written after he left.
    const after = await sealNote(
      rotated.orgPublic,
      'family-link-9',
      'Written after Bob left.',
    );
    await expect(openNote({ ...after, keyVersion: 1 }, bobRetainedV1)).rejects.toThrow();
  });
});
