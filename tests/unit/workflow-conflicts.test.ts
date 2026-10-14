import { describe, expect, it } from 'vitest';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { CertificateConflictError } from '@/domains/certificates/errors';
import { DecisionWorkflowError } from '@/domains/decisions/errors';
import { certificates } from '@/db/schema/certificates';
import { toErrorResponse } from '@/lib/http/tenant-route';

describe('workflow conflict responses', () => {
  it('maps a proposal on a case that is still in review to 409', async () => {
    const response = toErrorResponse(new DecisionWorkflowError('in_review'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Case is not ready for a committee decision',
    });
  });

  it('maps an illegal case transition to 409', async () => {
    const response = toErrorResponse(
      new ApplicationWorkflowError('record_decision', 'in_review'),
    );
    expect(response.status).toBe(409);
  });

  it('maps a second live certificate to 409', async () => {
    const response = toErrorResponse(new CertificateConflictError());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'A live certificate already exists for this decision',
    });
  });
});

describe('certificate live-decision index', () => {
  it('is a partial unique index on decision_id excluding revoked and deleted rows', () => {
    const { indexes } = getTableConfig(certificates);
    const live = indexes.find(
      (index) => index.config.name === 'certificates_live_decision_unique',
    );
    expect(live?.config.unique).toBe(true);
    const column = live?.config.columns[0];
    expect(column && 'name' in column ? column.name : undefined).toBe('decision_id');
    expect(live?.config.where).toBeDefined();
    const sql = new PgDialect().sqlToQuery(live!.config.where!).sql.toLowerCase();
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('is null');
    expect(sql).toContain('revoked');
  });
});
