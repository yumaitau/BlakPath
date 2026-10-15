import { describe, expect, it } from 'vitest';

import {
  executeActivate,
  executeProvision,
  executeRecordAgreement,
  executeRecordChecklist,
  type NewOrganisationRecord,
  type OnboardingDeps,
  type OnboardingStore,
  type PlatformAuditWrite,
  type StoredOrganisation,
} from '@/domains/onboarding/execute';
import {
  adminInviteEmail,
  cloneableRoleTemplates,
  evaluateActivation,
  hashInvitationToken,
  initialReadinessChecklist,
  isChecklistComplete,
  recordChecklistItem,
  type ReadinessChecklist,
  type ReadinessItemKey,
} from '@/domains/onboarding/policy';
import { isCodedAuditReason } from '@/domains/audit/hash';
import {
  SYSTEM_ROLE_SEED,
  isRoleAssignableToOrganisation,
} from '@/lib/permissions/roles';

const NOW = new Date('2026-10-13T00:00:00.000Z');
const TOKEN = 'invite-token-plain';
const OPERATOR_EMAIL = 'operator@blakpath.example';
const OPERATOR_ID = 'operator-user-1';

function templateRows() {
  return SYSTEM_ROLE_SEED.map((template) => ({
    slug: template.slug,
    name: template.name,
    description: template.description,
    permissions: [...template.permissions],
  }));
}

function catalogue(): Set<string> {
  return new Set(templateRows().flatMap((template) => template.permissions));
}

class MemoryStore implements OnboardingStore {
  readonly saved: NewOrganisationRecord[] = [];
  readonly orgs = new Map<string, StoredOrganisation>();
  /** Events the store appended with its own writes (same transaction). */
  readonly audits: PlatformAuditWrite[] = [];
  statusUpdates = 0;

  async findPlatformOperator(email: string) {
    return email === OPERATOR_EMAIL ? { id: OPERATOR_ID } : null;
  }

  async findBySlug(slug: string): Promise<StoredOrganisation | null> {
    return [...this.orgs.values()].find((org) => org.slug === slug) ?? null;
  }

  async findById(organisationId: string): Promise<StoredOrganisation | null> {
    return this.orgs.get(organisationId) ?? null;
  }

  async loadSystemRoleTemplates() {
    return templateRows();
  }

  async permissionCatalogueKeys() {
    return catalogue();
  }

  async saveNew(record: NewOrganisationRecord, audit: PlatformAuditWrite) {
    this.saved.push(record);
    this.audits.push(audit);
    this.orgs.set(record.id, {
      id: record.id,
      slug: record.slug,
      legalName: record.legalName,
      status: record.status,
      keyValidated: false,
      checklist: record.checklist,
      agreementReference: record.agreementReference,
      agreementSignedAt: record.agreementSignedAt,
      pendingInvitation: {
        id: record.invitation.id,
        email: record.invitation.email,
        roleName: 'Organisation Administrator',
      },
    });
  }

  async saveChecklist(
    organisationId: string,
    checklist: ReadinessChecklist,
    audit?: PlatformAuditWrite,
  ) {
    const org = this.orgs.get(organisationId);
    if (!org) return;
    if (audit) this.audits.push(audit);
    this.orgs.set(organisationId, { ...org, checklist });
  }

  async saveAgreement(
    organisationId: string,
    agreement: { reference: string; signedAt: Date },
    audit?: PlatformAuditWrite,
  ) {
    const org = this.orgs.get(organisationId);
    if (!org) return;
    if (audit) this.audits.push(audit);
    this.orgs.set(organisationId, {
      ...org,
      agreementReference: agreement.reference,
      agreementSignedAt: agreement.signedAt,
    });
  }

  async setStatusOnboardingToActive(organisationId: string, audit: PlatformAuditWrite) {
    const org = this.orgs.get(organisationId);
    if (!org || org.status !== 'onboarding') return false;
    this.audits.push(audit);
    this.statusUpdates += 1;
    this.orgs.set(organisationId, { ...org, status: 'active' });
    return true;
  }

  async rotatePendingInvitation(_invitation: unknown, audit: PlatformAuditWrite) {
    this.audits.push(audit);
    return true;
  }

  validateKey(): void {
    for (const [id, org] of this.orgs) this.orgs.set(id, { ...org, keyValidated: true });
  }
}

function harness(store = new MemoryStore()): {
  store: MemoryStore;
  audits: PlatformAuditWrite[];
  emails: Array<{ to: string; subject: string; text: string }>;
  deps: OnboardingDeps;
} {
  let sequence = 0;
  // One ordered list: transactional appends from the store and standalone
  // failure/denial events from effects.
  const audits = store.audits;
  const emails: Array<{ to: string; subject: string; text: string }> = [];
  return {
    store,
    audits,
    emails,
    deps: {
      store,
      effects: {
        appUrl: 'https://blakpath.example.org/',
        now: () => NOW,
        newId: () => `id-${++sequence}`,
        newToken: () => TOKEN,
        audit: async (event) => {
          audits.push(event);
        },
        sendInvite: async (message) => {
          emails.push(message);
        },
      },
    },
  };
}

const provisionInput = {
  legalName: 'Example Aboriginal Corporation',
  slug: 'Example-AC',
  adminEmail: 'Admin@Example.org',
  operatorEmail: OPERATOR_EMAIL,
  organisationType: 'council',
};

async function readyOrganisation(store: MemoryStore): Promise<void> {
  const org = store.orgs.values().next().value;
  if (!org) throw new Error('missing org');
  let checklist = initialReadinessChecklist();
  for (const item of checklist.items) {
    checklist = recordChecklistItem(checklist, item.key, true, NOW.toISOString());
  }
  await store.saveChecklist(org.id, checklist);
  await store.saveAgreement(org.id, {
    reference: 'MSA-2026-014',
    signedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  store.validateKey();
}

describe('organisation provisioning policy', () => {
  it('clones tenant roles without the platform operator or its permission', () => {
    const cloned = cloneableRoleTemplates();
    expect(cloned.map((role) => role.slug)).not.toContain('platform-operator');
    expect(cloned.flatMap((role) => [...role.permissions])).not.toContain(
      'break-glass:request',
    );
  });

  it('refuses to assign the platform operator or another tenant role', () => {
    expect(
      isRoleAssignableToOrganisation(
        { organisationId: null, isSystem: true, slug: 'platform-operator' },
        'org-1',
      ),
    ).toBe(false);
    expect(
      isRoleAssignableToOrganisation(
        { organisationId: 'org-2', isSystem: true, slug: 'organisation-admin' },
        'org-1',
      ),
    ).toBe(false);
    expect(
      isRoleAssignableToOrganisation(
        { organisationId: 'org-1', isSystem: true, slug: 'organisation-admin' },
        'org-1',
      ),
    ).toBe(true);
    expect(
      isRoleAssignableToOrganisation(
        { organisationId: null, isSystem: true, slug: 'organisation-admin' },
        'org-1',
      ),
    ).toBe(true);
  });

  it('starts the checklist incomplete and records one human item at a time', () => {
    const checklist = initialReadinessChecklist();
    expect(isChecklistComplete(checklist)).toBe(false);
    expect(checklist.items.every((item) => item.complete === false)).toBe(true);
    const next = recordChecklistItem(
      checklist,
      'consent_wording',
      true,
      NOW.toISOString(),
    );
    expect(next.items.find((item) => item.key === 'consent_wording')?.complete).toBe(
      true,
    );
    expect(
      next.items
        .filter((item) => item.key !== 'consent_wording')
        .every((item) => !item.complete),
    ).toBe(true);
    expect(isChecklistComplete(next)).toBe(false);
  });

  it('blocks activation until the checklist and a signed agreement are both recorded', () => {
    const checklist = initialReadinessChecklist();
    expect(
      evaluateActivation({
        status: 'onboarding',
        keyValidated: false,
        checklist,
        agreementReference: null,
        agreementSignedAt: null,
      }),
    ).toEqual({
      allowed: false,
      reasons: ['key_not_validated', 'checklist_incomplete', 'agreement_missing'],
    });

    let complete = checklist;
    for (const item of checklist.items) {
      complete = recordChecklistItem(complete, item.key, true, NOW.toISOString());
    }
    expect(
      evaluateActivation({
        status: 'onboarding',
        keyValidated: true,
        checklist: complete,
        agreementReference: null,
        agreementSignedAt: null,
      }).allowed,
    ).toBe(false);
    // Checklist and agreement are not enough without a validated tenant key.
    expect(
      evaluateActivation({
        status: 'onboarding',
        keyValidated: false,
        checklist: complete,
        agreementReference: 'MSA-2026-014',
        agreementSignedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).toEqual({ allowed: false, reasons: ['key_not_validated'] });
    expect(
      evaluateActivation({
        status: 'onboarding',
        keyValidated: true,
        checklist: complete,
        agreementReference: 'MSA-2026-014',
        agreementSignedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateActivation({
        status: 'suspended',
        keyValidated: true,
        checklist: complete,
        agreementReference: 'MSA-2026-014',
        agreementSignedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).toEqual({ allowed: false, reasons: ['not_onboarding'] });
  });

  it('hashes the invitation token and does not put a password in the email', () => {
    expect(hashInvitationToken(TOKEN)).toHaveLength(64);
    expect(hashInvitationToken(TOKEN)).not.toBe(TOKEN);
    const email = adminInviteEmail({
      legalName: 'Example Aboriginal Corporation',
      joinUrl: `https://blakpath.example.org/join/${TOKEN}`,
    });
    expect(email.text).toContain('does not include a password');
    expect(email.text).toContain('passkey or an authenticator');
    expect(email.text).toContain(`/join/${TOKEN}`);
    expect(email.text).not.toMatch(/password\s*[:=]/i);
  });
});

describe('organisation provisioning command', () => {
  it('creates an onboarding organisation, emails the admin, and audits the operator', async () => {
    const { store, audits, emails, deps } = harness();
    const result = await executeProvision(provisionInput, deps);
    const saved = store.saved[0];
    if (!saved) throw new Error('expected a saved organisation');

    expect(result).toEqual({
      organisationId: saved.id,
      slug: 'example-ac',
      status: 'onboarding',
      created: true,
      invitationSent: true,
    });
    expect(saved.status).toBe('onboarding');
    expect(saved.region).toBe('ap-southeast-2');
    expect(saved.publicApplicationsOpen).toBe(false);
    expect(saved.memberships).toEqual([]);
    expect(saved.roles.map((role) => role.slug)).not.toContain('platform-operator');
    expect(saved.roles.flatMap((role) => [...role.permissions])).not.toContain(
      'break-glass:request',
    );
    expect(saved.invitation.email).toBe('admin@example.org');
    expect(saved.invitation.tokenHash).toBe(hashInvitationToken(TOKEN));
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toMatch(/password/i);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toBe('admin@example.org');
    expect(emails[0]?.text).toContain(`/join/${TOKEN}`);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'admin.organisation_provisioned',
        result: 'success',
        resourceId: saved.id,
        actorUserId: OPERATOR_ID,
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    // The operator is recorded by user id. No email address enters the trail.
    expect(JSON.stringify(audits)).not.toContain('@');
    expect(audits[0]?.after?.data).toMatchObject({ slug: 'example-ac' });
  });

  it('is a no-op when the slug already exists', async () => {
    const { store, audits, emails, deps } = harness();
    await executeProvision(provisionInput, deps);
    const again = await executeProvision(provisionInput, deps);
    expect(again.created).toBe(false);
    expect(again.invitationSent).toBe(false);
    expect(store.saved).toHaveLength(1);
    expect(emails).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('does not email or audit success when the slug races', async () => {
    const { store, audits, emails, deps } = harness();
    let lookups = 0;
    store.saveNew = async () => {
      const error = new Error('duplicate') as Error & { code: string };
      error.code = '23505';
      throw error;
    };
    store.findBySlug = async (slug) => {
      lookups += 1;
      if (lookups === 1) return null;
      return {
        id: 'existing',
        slug,
        legalName: 'Example',
        status: 'onboarding',
        keyValidated: false,
        checklist: null,
        agreementReference: null,
        agreementSignedAt: null,
        pendingInvitation: null,
      };
    };
    const result = await executeProvision(provisionInput, deps);
    expect(result).toMatchObject({
      created: false,
      invitationSent: false,
      organisationId: 'existing',
    });
    expect(emails).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('refuses to become active until the checklist and agreement are recorded', async () => {
    const { store, audits, deps } = harness();
    await executeProvision(provisionInput, deps);
    await expect(
      executeActivate({ slug: 'example-ac', operatorEmail: OPERATOR_EMAIL }, deps),
    ).rejects.toMatchObject({
      code: 'ACTIVATION_REFUSED',
      reasons: ['key_not_validated', 'checklist_incomplete', 'agreement_missing'],
    });
    expect(store.statusUpdates).toBe(0);
    expect(store.orgs.values().next().value?.status).toBe('onboarding');
    expect(audits.at(-1)).toMatchObject({
      action: 'admin.organisation_activated',
      result: 'denied',
      reason: 'onboarding.activation_refused',
      actorUserId: OPERATOR_ID,
    });

    await executeRecordChecklist(
      {
        target: { slug: 'example-ac', operatorEmail: OPERATOR_EMAIL },
        item: 'consent_wording' satisfies ReadinessItemKey,
        complete: true,
      },
      deps,
    );
    expect(store.statusUpdates).toBe(0);

    await readyOrganisation(store);
    const activated = await executeActivate(
      { slug: 'example-ac', operatorEmail: OPERATOR_EMAIL },
      deps,
    );
    expect(activated).toMatchObject({ status: 'active', changed: true });
    expect(store.statusUpdates).toBe(1);
    expect(store.orgs.values().next().value?.status).toBe('active');
    const again = await executeActivate(
      { slug: 'example-ac', operatorEmail: OPERATOR_EMAIL },
      deps,
    );
    expect(again.changed).toBe(false);
    expect(store.statusUpdates).toBe(1);
  });

  it('records a signed agreement without activating', async () => {
    const { store, deps } = harness();
    await executeProvision(provisionInput, deps);
    await executeRecordAgreement(
      {
        slug: 'example-ac',
        reference: 'MSA-2026-014',
        signedAt: '2026-10-01',
        operatorEmail: OPERATOR_EMAIL,
      },
      deps,
    );
    expect(store.statusUpdates).toBe(0);
    expect(store.orgs.values().next().value?.agreementReference).toBe('MSA-2026-014');
    expect(store.orgs.values().next().value?.status).toBe('onboarding');
  });

  it('audits an email failure without returning the token', async () => {
    const { audits, deps } = harness();
    deps.effects.sendInvite = async () => {
      throw new Error(`smtp body ${TOKEN}`);
    };
    await expect(executeProvision(provisionInput, deps)).rejects.toMatchObject({
      code: 'INVITE_EMAIL_FAILED',
    });
    // The organisation and its event committed together; the failed send is
    // a second, standalone event.
    expect(audits.map((event) => event.result)).toEqual(['success', 'failure']);
    expect(audits[1]?.reason).toBe('onboarding.invitation_email_failed');
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('refuses an operator email without a platform operator account', async () => {
    const { store, audits, emails, deps } = harness();
    await expect(
      executeProvision({ ...provisionInput, operatorEmail: 'someone@example.org' }, deps),
    ).rejects.toMatchObject({ code: 'OPERATOR_NOT_FOUND' });
    expect(store.saved).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('writes only coded audit reasons', async () => {
    const { audits, deps } = harness();
    await executeProvision(provisionInput, deps);
    await expect(
      executeActivate({ slug: 'example-ac', operatorEmail: OPERATOR_EMAIL }, deps),
    ).rejects.toMatchObject({ code: 'ACTIVATION_REFUSED' });
    for (const event of audits) {
      if (event.reason !== undefined) expect(isCodedAuditReason(event.reason)).toBe(true);
    }
  });
});
