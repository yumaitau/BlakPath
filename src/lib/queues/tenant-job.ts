import { z } from 'zod';

/**
 * Shape shared by every background job.
 *
 * Extra keys are allowed: processors read opaque ids (evidence, notification,
 * delivery) from the same payload. Only the tenant fields are checked here.
 * The worker parses this again on consume; enqueue validation is not enough.
 */
export const tenantJobSchema = z.looseObject({
  organisationId: z.uuid(),
  correlationId: z.string().trim().min(1).max(512),
});

export type ParsedTenantJob = z.infer<typeof tenantJobSchema>;
