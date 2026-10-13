import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applicationIntakeAuditMeta } from '@/domains/applications/audit-meta';
import {
  assertCodedAuditReason,
  auditReason,
  canonicalEventPayload,
  isCodedAuditReason,
  isForbiddenAuditKey,
  redactMeta,
  type HashableAuditEvent,
} from '@/domains/audit/hash';

const APPLICANT_NAME = 'Zephyr Quoll';
const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function allowlistedKeys(source: string): string[] {
  const keys: string[] = [];
  const allow = /allow\s*:\s*\[([\s\S]*?)\]/g;
  const quoted = /['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(allow)) {
    const body = match[1] ?? '';
    for (const key of body.matchAll(quoted)) {
      if (key[1]) keys.push(key[1]);
    }
  }
  return keys;
}

function callBlocks(source: string, callee: string): string[] {
  const blocks: string[] = [];
  const needle = `${callee}(`;
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    const brace = source.indexOf('{', at);
    if (brace < 0) break;
    let depth = 0;
    let end = brace;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(brace, end + 1));
    from = end + 1;
  }
  return blocks;
}

function event(overrides: Partial<HashableAuditEvent> = {}): HashableAuditEvent {
  return {
    id: '1',
    organisationId: 'org-1',
    timestamp: '2026-07-12T00:00:01.000Z',
    actorUserId: 'user-1',
    actingRole: 'reviewer',
    sessionId: 'sess-1',
    action: 'application.updated',
    resourceType: 'application',
    resourceId: 'app-1',
    result: 'success',
    reason: null,
    ipAddress: null,
    userAgent: null,
    correlationId: 'corr-1',
    requestId: 'req-1',
    beforeMeta: null,
    afterMeta: null,
    ...overrides,
  };
}

describe('audit personal-data denylist', () => {
  it('treats names, contact details, notes, file names and answers as forbidden', () => {
    for (const key of [
      'name',
      'applicantName',
      'fileName',
      'email',
      'emailAddress',
      'phone',
      'phoneNumber',
      'note',
      'decisionNote',
      'answers',
      'rawAnswers',
    ]) {
      expect(isForbiddenAuditKey(key), key).toBe(true);
    }
    for (const key of [
      'changed',
      'priority',
      'status',
      'statusHistoryId',
      'applicationId',
      'algorithm',
    ]) {
      expect(isForbiddenAuditKey(key), key).toBe(false);
    }
  });

  it('redacts an allowlisted personal value instead of hashing it', () => {
    const out = redactMeta(
      {
        applicantName: APPLICANT_NAME,
        email: 'zephyr@example.com',
        phone: '0400000000',
        note: `call ${APPLICANT_NAME}`,
        fileName: `${APPLICANT_NAME}.pdf`,
        answers: { who: APPLICANT_NAME },
        priority: 'normal',
      },
      ['applicantName', 'email', 'phone', 'note', 'fileName', 'answers', 'priority'],
    );
    expect(JSON.stringify(out)).not.toContain(APPLICANT_NAME);
    expect(JSON.stringify(out)).not.toContain('zephyr@example.com');
    expect(out).toMatchObject({
      applicantName: '[REDACTED]',
      email: '[REDACTED]',
      phone: '[REDACTED]',
      note: '[REDACTED]',
      fileName: '[REDACTED]',
      answers: '[REDACTED]',
      priority: 'normal',
    });
  });

  it('fails if a PII key enters any audit allowlist', () => {
    const hits: { file: string; key: string }[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const key of allowlistedKeys(source)) {
        if (isForbiddenAuditKey(key)) hits.push({ file, key });
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('coded audit reasons', () => {
  it('accepts a code and an id reference, and refuses free text', () => {
    const historyId = '018f5b3a-7c3e-7d2a-8b10-123456789abc';
    expect(auditReason('application.transition_note', historyId)).toBe(
      `application.transition_note:${historyId}`,
    );
    expect(isCodedAuditReason('evidence.not_servable')).toBe(true);
    expect(isCodedAuditReason('calendar.rsvp:needs-action')).toBe(true);

    const prose = `Withdrawn after speaking with ${APPLICANT_NAME}`;
    expect(() => assertCodedAuditReason(prose)).toThrow(/coded value/);
    try {
      assertCodedAuditReason(prose);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(APPLICANT_NAME);
    }
  });

  it('keeps reason literals in source coded', () => {
    const reasonLiteral = /reason\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
    const bad: { file: string; value: string }[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(reasonLiteral)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        const template =
          match[3] !== undefined && match[1] === undefined && match[2] === undefined;
        if (template || !isCodedAuditReason(value)) {
          bad.push({ file, value });
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('rename, evidence and retention audit payloads', () => {
  it('records a rename as the field name, with no applicant name in the chain payload', () => {
    const meta = applicationIntakeAuditMeta({
      beforePriority: 'normal',
      afterPriority: 'normal',
      changed: ['applicantName'],
    });
    const before = redactMeta(meta.before.data, meta.before.allow);
    const after = redactMeta(meta.after.data, meta.after.allow);
    expect(after).toEqual({ changed: ['applicantName'], priority: 'normal' });

    const serialised = canonicalEventPayload(
      null,
      event({
        beforeMeta: before,
        afterMeta: after,
        reason: auditReason(
          'application.transition_note',
          '018f5b3a-7c3e-7d2a-8b10-123456789abc',
        ),
      }),
    );
    expect(serialised).not.toContain(APPLICANT_NAME);
    expect(serialised).toContain('applicantName');
  });

  it('drops a file name that is not allowlisted', () => {
    const out = redactMeta(
      { applicationId: 'app-1', fileName: `${APPLICANT_NAME}.pdf` },
      ['applicationId'],
    );
    expect(out).toEqual({ applicationId: 'app-1' });
    expect(JSON.stringify(out)).not.toContain(APPLICANT_NAME);
  });

  it('does not pass the applicant name or file name into audit writes', () => {
    const app = readFileSync(join(SRC, 'domains/applications/service.ts'), 'utf8');
    for (const block of callBlocks(app, 'recordAudit')) {
      expect(block).not.toMatch(/applicantName|fileName|input\.note/);
    }

    const evidence = readFileSync(join(SRC, 'domains/evidence/service.ts'), 'utf8');
    const evidenceBlocks = [
      ...callBlocks(evidence, 'recordAudit'),
      ...callBlocks(evidence, 'systemAudit'),
    ];
    for (const block of evidenceBlocks) {
      expect(block).not.toMatch(/fileName|applicantName/);
    }
  });

  it('leaves no applicant name in the retention anonymise audit write', () => {
    const sweep = readFileSync(join(SRC, 'domains/retention/sweep.ts'), 'utf8');
    const blocks = callBlocks(sweep, 'sysAudit');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toContain('applicantName');
      expect(block).not.toContain(APPLICANT_NAME);
    }

    const retentionAudit = event({
      action: 'retention.record_anonymised',
      reason: null,
      beforeMeta: null,
      afterMeta: null,
    });
    const rename = applicationIntakeAuditMeta({
      beforePriority: 'normal',
      afterPriority: 'normal',
      changed: ['applicantName'],
    });
    const blob = JSON.stringify({
      retentionAudit,
      before: redactMeta(rename.before.data, rename.before.allow),
      after: redactMeta(rename.after.data, rename.after.allow),
    });
    expect(blob).not.toContain(APPLICANT_NAME);
  });
});
