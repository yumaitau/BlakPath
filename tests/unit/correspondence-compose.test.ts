import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@/lib/permissions/roles';
import {
  PREVIEW_PORTAL_TEXT,
  STARTER_TEMPLATES,
  STORED_PORTAL_TEXT,
  blankMergeFields,
  emailContainsSensitiveDetail,
  emailFromIntake,
  formatCorrespondenceDate,
  maySendKind,
  mergeFieldTokens,
  minimiseEmail,
  outcomeLabel,
  renderMerge,
  sendBlock,
  starterFor,
  unknownMergeFields,
  type SendFacts,
} from '@/domains/correspondence/compose';
import { renderLetterPdf } from '@/domains/correspondence/letter-pdf';

function facts(overrides: Partial<SendFacts> = {}): SendFacts {
  return {
    kind: 'general',
    status: 'draft',
    channel: 'email',
    decisionStatus: null,
    certificateStatus: null,
    evidenceDueAt: null,
    recipientEmail: 'person@example.com',
    missingMergeFields: [],
    hasRelatedRecord: true,
    ...overrides,
  };
}

describe('merge fields', () => {
  it('rejects tokens outside the closed list', () => {
    expect(unknownMergeFields('Hello {{decision.outcome}}')).toEqual([]);
    expect(unknownMergeFields('{{drop table}} and {{score}}')).toEqual([
      'drop table',
      'score',
    ]);
  });

  it('renders known fields and leaves unknown tokens in place', () => {
    const rendered = renderMerge('{{applicant.name}} {{not.a.field}}', {
      'applicant.name': 'Alex',
    });
    expect(rendered).toBe('Alex {{not.a.field}}');
  });

  it('reports blank referenced fields', () => {
    expect(
      blankMergeFields('Due {{evidence.due_date}}', { 'evidence.due_date': '  ' }),
    ).toEqual(['evidence.due_date']);
  });

  it('starter templates only use known fields', () => {
    for (const template of STARTER_TEMPLATES) {
      expect(unknownMergeFields(template.subjectTemplate)).toEqual([]);
      expect(unknownMergeFields(template.bodyTemplate)).toEqual([]);
      expect(mergeFieldTokens(template.bodyTemplate).length).toBeGreaterThan(0);
    }
  });
});

describe('outcome labels', () => {
  it('spells a recorded outcome and does not invent one', () => {
    expect(outcomeLabel('confirmed')).toBe('Confirmed');
    expect(outcomeLabel('not_confirmed')).toBe('Not confirmed');
    expect(outcomeLabel('deferred')).toBe('Deferred');
    expect(outcomeLabel('approved')).toBe('');
    expect(outcomeLabel(null)).toBe('');
  });
});

describe('send gates', () => {
  it('blocks an outcome letter until the decision is finalised', () => {
    expect(
      sendBlock(
        facts({
          kind: 'outcome',
          decisionStatus: 'proposed',
          hasRelatedRecord: true,
        }),
      ),
    ).toBe('decision_not_finalised');
    expect(
      sendBlock(
        facts({
          kind: 'outcome',
          decisionStatus: null,
          hasRelatedRecord: false,
        }),
      ),
    ).toBe('related_record_required');
    expect(
      sendBlock(
        facts({
          kind: 'outcome',
          decisionStatus: 'finalised',
        }),
      ),
    ).toBeNull();
  });

  it('refuses to send a letter that was already sent', () => {
    expect(sendBlock(facts({ status: 'sent' }))).toBe('not_draft');
  });

  it('requires a due date on an evidence request notice', () => {
    expect(
      sendBlock(
        facts({
          kind: 'evidence_request',
          evidenceDueAt: null,
        }),
      ),
    ).toBe('evidence_due_date_required');
    expect(
      sendBlock(
        facts({
          kind: 'evidence_request',
          evidenceDueAt: new Date('2026-06-15T02:00:00.000Z'),
        }),
      ),
    ).toBeNull();
  });

  it('requires a signed certificate, or a revoked one for revocation', () => {
    expect(sendBlock(facts({ kind: 'certificate', certificateStatus: 'draft' }))).toBe(
      'certificate_not_issued',
    );
    expect(
      sendBlock(facts({ kind: 'certificate', certificateStatus: 'signed' })),
    ).toBeNull();
    expect(sendBlock(facts({ kind: 'revocation', certificateStatus: 'signed' }))).toBe(
      'certificate_not_revoked',
    );
    expect(
      sendBlock(facts({ kind: 'revocation', certificateStatus: 'revoked' })),
    ).toBeNull();
  });

  it('requires an email address only for the email channel', () => {
    expect(sendBlock(facts({ channel: 'email', recipientEmail: null }))).toBe(
      'recipient_email_required',
    );
    expect(sendBlock(facts({ channel: 'letter', recipientEmail: null }))).toBeNull();
  });

  it('blocks send when a merge field is blank', () => {
    expect(sendBlock(facts({ missingMergeFields: ['decision.outcome'] }))).toBe(
      'missing_merge_values',
    );
  });
});

describe('who may send', () => {
  it('lets a chair send an outcome and keeps that off the case officer', () => {
    const chair = new Set<string>(SYSTEM_ROLES['committee-chair'].permissions);
    const officer = new Set<string>(SYSTEM_ROLES['case-officer'].permissions);
    const intake = new Set<string>(SYSTEM_ROLES['intake-officer'].permissions);
    const records = new Set<string>(SYSTEM_ROLES['records-officer'].permissions);
    expect(maySendKind('outcome', chair)).toBe(true);
    expect(maySendKind('outcome', officer)).toBe(false);
    expect(maySendKind('evidence_request', intake)).toBe(true);
    expect(maySendKind('evidence_request', officer)).toBe(true);
    expect(maySendKind('certificate', records)).toBe(true);
    expect(maySendKind('certificate', officer)).toBe(false);
    expect(maySendKind('general', officer)).toBe(true);
    expect(maySendKind('outcome', new Set(['correspondence:send']))).toBe(false);
  });
});

describe('minimised email', () => {
  const detail = {
    outcomeLabel: 'Confirmed',
    evidenceSummary: 'Birth certificate of your grandmother',
    certificateReference: 'CERT-2026-000123',
  };

  it('keeps outcome, evidence detail and certificate reference out of the email', () => {
    const values = {
      'applicant.name': 'Alex',
      'application.reference': 'APP-2026-0007',
      'organisation.name': 'Example Organisation',
      'decision.outcome': detail.outcomeLabel,
      'decision.finalised_on': '15 June 2026',
      'evidence.summary': detail.evidenceSummary,
      'certificate.reference': detail.certificateReference,
      'portal.url': STORED_PORTAL_TEXT,
    };
    const letter = renderMerge(starterFor('outcome').bodyTemplate, values);
    expect(letter).toContain('Confirmed');
    expect(letter).not.toContain('https://');

    const email = minimiseEmail({
      kind: 'outcome',
      organisationName: 'Example Organisation',
      applicationReference: 'APP-2026-0007',
      portalUrl: 'https://example.test/c/secret-token',
      expiresOn: '29 June 2026',
    });
    expect(email.subject).toBe('Update on application APP-2026-0007');
    expect(email.text).toContain('https://example.test/c/secret-token');
    expect(email.text).not.toContain(letter);
    expect(emailContainsSensitiveDetail(email, detail)).toBe(false);
  });

  it('includes the evidence due date and not the request detail', () => {
    const email = minimiseEmail({
      kind: 'evidence_request',
      organisationName: 'Example Organisation',
      applicationReference: 'APP-2026-0007',
      portalUrl: PREVIEW_PORTAL_TEXT,
      expiresOn: '29 June 2026',
      dueDate: '15 June 2026',
    });
    expect(email.text).toContain('15 June 2026');
    expect(emailContainsSensitiveDetail(email, detail)).toBe(false);
  });
});

describe('intake email', () => {
  it('reads a contact email and ignores anything else', () => {
    expect(emailFromIntake({ email: ' person@example.com ' })).toBe('person@example.com');
    expect(emailFromIntake({ contactEmail: 'not-an-email' })).toBeNull();
    expect(emailFromIntake(null)).toBeNull();
    expect(emailFromIntake({ notes: 'secret family story' })).toBeNull();
  });
});

describe('dates', () => {
  it('formats a calendar date in Australia/Sydney', () => {
    expect(formatCorrespondenceDate(new Date('2026-06-15T02:00:00.000Z'))).toBe(
      '15 June 2026',
    );
  });
});

describe('printed letter', () => {
  it('renders a PDF without throwing on characters outside WinAnsi', () => {
    return renderLetterPdf({
      organisationName: 'Example Organisation',
      subject: 'Letter',
      body: 'Hello Alex 🌿\nSecond paragraph.',
      applicationReference: 'APP-2026-0007',
    }).then((pdf) => {
      expect(pdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
      expect(pdf.length).toBeGreaterThan(500);
    });
  });
});

describe('no automatic applicant mail', () => {
  it('finalising a decision does not send correspondence', () => {
    const src = readFileSync(resolve('src/domains/decisions/service.ts'), 'utf8');
    expect(src).not.toContain('queueTenantEmail');
    expect(src).not.toContain('sendCorrespondence');
    expect(src).not.toContain('draftCorrespondence');
  });

  it('requesting evidence does not notify the applicant', () => {
    const src = readFileSync(resolve('src/domains/evidence/service.ts'), 'utf8');
    expect(src).not.toContain('queueTenantEmail');
    expect(src).not.toContain('sendEvidenceRequestNotice');
  });
});
