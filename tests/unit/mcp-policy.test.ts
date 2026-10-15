import { describe, expect, it } from 'vitest';
import { redactMeta } from '@/domains/audit/hash';
import { MCP_TOOLS } from '@/domains/mcp/tools';
import {
  AiFeatureChangeError,
  allowsMcpPii,
  assertAiFeatureChange,
  hasMcpScope,
  mcpAuditAfter,
  mcpHttpStatus,
  mcpRateAllows,
  mcpRateWindow,
  minimiseMcpValue,
} from '@/domains/mcp/policy';

describe('MCP endpoint gate', () => {
  it('hides the endpoint when the platform flag is off', () => {
    expect(
      mcpHttpStatus({
        globalEnabled: false,
        tenantOptedIn: true,
        hasMcpScope: true,
      }),
    ).toBe(404);
    expect(
      mcpHttpStatus({
        globalEnabled: false,
        tenantOptedIn: false,
        hasMcpScope: false,
      }),
    ).toBe(404);
  });

  it('refuses a tenant that has not opted in', () => {
    expect(
      mcpHttpStatus({
        globalEnabled: true,
        tenantOptedIn: false,
        hasMcpScope: true,
      }),
    ).toBe(403);
  });

  it('refuses a key without an mcp scope', () => {
    expect(
      mcpHttpStatus({
        globalEnabled: true,
        tenantOptedIn: true,
        hasMcpScope: false,
      }),
    ).toBe(403);
  });

  it('allows a call only when the flag, opt-in and scope all hold', () => {
    expect(
      mcpHttpStatus({
        globalEnabled: true,
        tenantOptedIn: true,
        hasMcpScope: true,
      }),
    ).toBe(200);
  });
});

describe('MCP tool output minimisation', () => {
  const application = {
    id: 'app-1',
    reference: 'APP-2026-0007',
    applicantName: 'Alex Example',
    applicantUserId: 'user-9',
    status: 'submitted',
    priority: 'normal',
    intake: { phone: '0400000000' },
  };

  const decision = {
    id: 'dec-1',
    proposedOutcome: 'supported',
    finalOutcome: 'supported',
    status: 'finalised',
  };

  it('omits applicant name and other direct identifiers by default', () => {
    const projected = minimiseMcpValue(application, false);
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain('Alex Example');
    expect(serialised).not.toContain('applicantName');
    expect(serialised).not.toContain('0400000000');
    expect(projected).toEqual({
      id: 'app-1',
      reference: 'APP-2026-0007',
      status: 'submitted',
      priority: 'normal',
    });
  });

  it('leaves timestamps intact while omitting names', () => {
    const when = new Date('2026-10-13T01:00:00.000Z');
    const projected = minimiseMcpValue(
      { id: 'meet-1', title: 'Smith family', scheduledStart: when, status: 'scheduled' },
      false,
    ) as { title?: string; scheduledStart: Date };
    expect(projected.title).toBeUndefined();
    expect(projected.scheduledStart).toBe(when);
  });

  it('omits recorded decision outcomes by default', () => {
    expect(minimiseMcpValue(decision, false)).toEqual({
      id: 'dec-1',
      status: 'finalised',
    });
  });

  it('includes names and outcomes only for the explicit disclosure scope', () => {
    expect(allowsMcpPii(new Set(['mcp:read']))).toBe(false);
    expect(allowsMcpPii(new Set(['mcp:read-pii']))).toBe(true);
    expect(hasMcpScope(new Set(['application:read-any']))).toBe(false);
    expect(hasMcpScope(new Set(['mcp:read']))).toBe(true);

    const disclosed = minimiseMcpValue(
      {
        applicantName: 'Alex Example',
        proposedOutcome: 'supported',
        status: 'finalised',
      },
      true,
    );
    expect(disclosed).toEqual({
      applicantName: 'Alex Example',
      proposedOutcome: 'supported',
      status: 'finalised',
    });
  });

  it('keeps the API key id on the audit metadata allowlist', () => {
    const meta = mcpAuditAfter({
      keyId: '018f6b2e-7c3a-7b2a-8c1d-9a0b1c2d3e4f',
      tool: 'get_application',
      piiDisclosed: false,
    });
    expect(redactMeta(meta.data, meta.allow)).toEqual({
      keyId: '018f6b2e-7c3a-7b2a-8c1d-9a0b1c2d3e4f',
      piiDisclosed: false,
      tool: 'get_application',
    });
  });

  it('declares an mcp scope on every tool', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.scopes.some((scope) => scope.startsWith('mcp:'))).toBe(true);
    }
  });
});

describe('tenant AI opt-in', () => {
  it('requires step-up before the flag can change', () => {
    expect(() =>
      assertAiFeatureChange({
        enabled: true,
        stepUpVerified: false,
        governanceReference: 'RES-2026-14',
        governanceStatement: 'Council approved limited tool access.',
      }),
    ).toThrow(AiFeatureChangeError);
    try {
      assertAiFeatureChange({
        enabled: false,
        stepUpVerified: false,
      });
    } catch (error) {
      expect((error as AiFeatureChangeError).code).toBe('STEP_UP_REQUIRED');
    }
  });

  it('requires a recorded governance approval to enable', () => {
    expect(() =>
      assertAiFeatureChange({
        enabled: true,
        stepUpVerified: true,
        governanceReference: '  ',
        governanceStatement: 'Approved',
      }),
    ).toThrow(AiFeatureChangeError);
    expect(() =>
      assertAiFeatureChange({
        enabled: true,
        stepUpVerified: true,
        governanceReference: 'RES-2026-14',
        governanceStatement: 'Council approved limited tool access.',
      }),
    ).not.toThrow();
    expect(() =>
      assertAiFeatureChange({ enabled: false, stepUpVerified: true }),
    ).not.toThrow();
  });
});

describe('MCP per-key rate window', () => {
  it('allows counts inside the ceiling and refuses the next', () => {
    expect(mcpRateAllows(1, 60)).toBe(true);
    expect(mcpRateAllows(60, 60)).toBe(true);
    expect(mcpRateAllows(61, 60)).toBe(false);
  });

  it('buckets a minute and reports a positive retry delay', () => {
    const atMinute = mcpRateWindow(60_000);
    const justAfter = mcpRateWindow(60_001);
    expect(atMinute.bucket).toBe(1);
    expect(justAfter.bucket).toBe(1);
    expect(mcpRateWindow(120_000).bucket).toBe(2);
    expect(justAfter.retryAfterSeconds).toBeGreaterThan(0);
    expect(justAfter.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});
