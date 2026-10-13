import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@/lib/permissions/catalog';
import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';
import {
  domainFunctionId,
  listDomainFunctions,
  type DomainFunction,
  type ParsedParam,
} from '../helpers/domain-functions';
import {
  seedTenantRows,
  snapshotOrganisation,
  TENANT_MARKER,
  type IsolationIds,
  type SeedResult,
} from './tenant-rls-seed';

/**
 * Calls every exported domain read/write as organisation A, passing organisation
 * B's ids where the parameter is a resource id. Scope-selecting parameters
 * (`organisationId` on workers and chain verification) stay on A so the call
 * does not legitimately run as B. A throw is a denial. A return value must not
 * contain B's marker or id, and B's rows must not change.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

interface Fixture {
  readonly orgA: string;
  readonly orgB: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly membershipId: string;
  readonly foreignId: string;
  readonly correlationId: string;
}

function pinnedCases(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('./cross-tenant-cases.json', import.meta.url), 'utf8'),
  );
  if (!Array.isArray(parsed)) throw new Error('cross-tenant-cases.json must be an array');
  return parsed.filter((item): item is string => typeof item === 'string');
}

function stringArg(name: string, fx: Fixture): string {
  if (name === 'organisationId') return fx.orgA;
  if (name === 'userId' || name === 'actorUserId' || name === 'applicantUserId')
    return fx.userId;
  if (name === 'sessionId') return fx.sessionId;
  if (name === 'membershipId') return fx.membershipId;
  if (name === 'token') return `missing-token-${fx.foreignId}`;
  if (name === 'address' || name === 'email')
    return `nobody-${fx.foreignId.slice(0, 8)}@example.test`;
  if (name === 'ipAddress') return '203.0.113.10';
  return fx.foreignId;
}

function valueFor(functionName: string, param: ParsedParam, fx: Fixture): unknown {
  const annotation = param.annotation.replace(/\s/g, '');
  if (param.name === 'now' || annotation === 'Date') return new Date();
  if (param.name === 'limit' || annotation === 'number') return 5;
  if (param.name === 'range') {
    return {
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    };
  }
  if (param.name === 'options' || annotation.includes('Options')) return {};
  if (param.name === 'order' || annotation.endsWith('[]')) return [];
  if (param.name === 'rawAnswers') return {};
  if (
    annotation === 'string' ||
    annotation.startsWith('string|') ||
    annotation === 'string|null'
  ) {
    return stringArg(param.name, fx);
  }
  return {
    organisationId: functionName === 'setActiveOrganisation' ? fx.orgB : fx.orgA,
    correlationId: fx.correlationId,
    userId: fx.userId,
    sessionId: fx.sessionId,
    membershipId: fx.membershipId,
    applicationId: fx.foreignId,
    evidenceId: fx.foreignId,
    notificationId: fx.foreignId,
    exportRequestId: fx.foreignId,
    deliveryId: fx.foreignId,
    endpointId: fx.foreignId,
    formId: fx.foreignId,
    reviewId: fx.foreignId,
    decisionId: fx.foreignId,
    meetingId: fx.foreignId,
    certificateId: fx.foreignId,
    taskId: fx.foreignId,
    id: fx.foreignId,
    resourceId: fx.foreignId,
    resourceType: 'application',
    action: 'application.viewed',
    result: 'denied',
    reason: 'cross-tenant probe',
    token: `missing-token-${fx.foreignId}`,
    email: `nobody-${fx.foreignId.slice(0, 8)}@example.test`,
    address: `nobody-${fx.foreignId.slice(0, 8)}@example.test`,
    fileName: 'record.pdf',
    contentType: 'application/pdf',
    sizeBytes: 128,
    title: 'cross-tenant probe',
    name: 'cross-tenant probe',
    key: `probe-${fx.foreignId}`,
    applicantName: 'Probe Applicant',
    enabled: false,
    active: false,
    jsonrpc: '2.0',
    method: 'ping',
  };
}

function buildArgs(fn: DomainFunction, fx: Fixture): unknown[] {
  const args: unknown[] = [];
  for (const param of fn.params) {
    if (param.name === 'database') break;
    args.push(valueFor(fn.name, param, fx));
  }
  return args;
}

function rendered(result: unknown): string {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(result))
    return result.toString('utf8');
  if (result instanceof Uint8Array) return Buffer.from(result).toString('utf8');
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

integration('cross-tenant domain cases', () => {
  const ids: IsolationIds = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    userId: randomUUID(),
  };
  let seeded: SeedResult;
  let fx: Fixture;
  let sqlClient: {
    unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
  };

  beforeAll(async () => {
    const client = await import('@/db/client');
    sqlClient = client.sqlClient;
    seeded = await seedTenantRows(sqlClient, ids);
    const membershipId = seeded.orgAIds.memberships;
    const foreignId = seeded.orgBIds.applications;
    if (!membershipId || !foreignId) {
      throw new Error('Fixture did not seed memberships and applications.');
    }
    fx = {
      orgA: ids.orgA,
      orgB: ids.orgB,
      userId: ids.userId,
      sessionId: randomUUID(),
      membershipId,
      foreignId,
      correlationId: randomUUID(),
    };
  }, 120_000);

  it('calls every exported domain function as org A with org B ids', async () => {
    const functions = listDomainFunctions();
    const pinned = pinnedCases();
    expect(functions.map(domainFunctionId)).toEqual(pinned);
    expect(functions.length).toBe(pinned.length);

    const context: TenantContext = {
      organisationId: fx.orgA,
      userId: fx.userId,
      membershipId: fx.membershipId,
      permissions: new Set(ALL_PERMISSIONS),
      roles: ['integration-tester'],
      sessionId: fx.sessionId,
      correlationId: fx.correlationId,
      requestId: randomUUID(),
    };

    let baseline = await snapshotOrganisation(sqlClient, seeded.tables, ids.orgB);
    const failures: string[] = [];
    const modules = new Map<string, Record<string, unknown>>();
    let invoked = 0;

    for (const fn of functions) {
      const id = domainFunctionId(fn);
      let loaded = modules.get(fn.specifier);
      if (!loaded) {
        loaded = (await import(fn.specifier)) as Record<string, unknown>;
        modules.set(fn.specifier, loaded);
      }
      const target = loaded[fn.name];
      if (typeof target !== 'function') {
        failures.push(`${id} is not an exported function`);
        continue;
      }
      invoked += 1;
      const args = buildArgs(fn, fx);
      try {
        const result = await runWithTenantContext(context, () =>
          (target as (...input: unknown[]) => Promise<unknown>)(...args),
        );
        const body = rendered(result);
        if (body.includes(TENANT_MARKER) || body.includes(ids.orgB)) {
          failures.push(`${id} returned organisation B data: ${body.slice(0, 180)}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (message.includes(TENANT_MARKER)) {
          failures.push(`${id} error leaked organisation B marker`);
        }
      }
      const next = await snapshotOrganisation(sqlClient, seeded.tables, ids.orgB);
      if (next !== baseline) {
        failures.push(`${id} mutated organisation B`);
        baseline = next;
      }
    }

    expect(invoked).toBe(pinned.length);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 180_000);
});
