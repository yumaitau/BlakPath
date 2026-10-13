import { z } from 'zod';
import { decodeApplicationCursor } from './cursor';
import { APPLICATION_STATUSES } from './workflow';

/**
 * Input validation for the applications domain (zod v4).
 *
 * Every value that crosses a trust boundary (form submission, route handler,
 * job payload) is parsed through one of these before the service touches it.
 * Tenant id and actor id are NEVER accepted here — they come only from the
 * DB-verified TenantContext, so they cannot be spoofed via input.
 */

const APPLICATION_PRIORITIES = ['low', 'normal', 'high'] as const;

/** Free-form organisation-defined intake fields (administrative only). */
const intakeSchema = z.record(z.string(), z.unknown());

/** Applicant's name as given — required, trimmed, bounded. */
const applicantNameSchema = z.string().trim().min(1).max(200);

/** Start a new application. */
export const createApplicationSchema = z.object({
  applicantName: applicantNameSchema,
  /** Link to an existing applicant account, when there is one. */
  applicantUserId: z.uuid().optional(),
  /** Owning client record (must belong to the tenant). */
  clientId: z.uuid().optional(),
  priority: z.enum(APPLICATION_PRIORITIES).default('normal'),
  intake: intakeSchema.optional(),
});
export type CreateApplicationInput = z.input<typeof createApplicationSchema>;

/** Update intake details on an existing application. All fields optional. */
export const updateIntakeSchema = z
  .object({
    applicantName: applicantNameSchema.optional(),
    priority: z.enum(APPLICATION_PRIORITIES).optional(),
    intake: intakeSchema.optional(),
    /** Optimistic-concurrency guard: the version the caller last read. */
    expectedUpdatedAt: z.coerce.date().optional(),
  })
  .refine(
    (value) =>
      value.applicantName !== undefined ||
      value.priority !== undefined ||
      value.intake !== undefined,
    { message: 'Provide at least one field to update.' },
  );
export type UpdateIntakeInput = z.input<typeof updateIntakeSchema>;

/** Assign (or reassign) an application to a worker. */
export const assignApplicationSchema = z.object({
  assigneeUserId: z.uuid(),
  /** The capacity the assignee acts in (a role slug), for the record. */
  roleContext: z.string().trim().min(1).max(100).optional(),
});
export type AssignApplicationInput = z.input<typeof assignApplicationSchema>;

/** Apply a workflow transition. */
export const transitionApplicationSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export type TransitionApplicationInput = z.input<typeof transitionApplicationSchema>;

const emptyToUndefined = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

/**
 * List/filter applications within the tenant.
 *
 * `q` matches a reference or applicant name through the blind index (a prefix
 * of a word, at least two characters). `cursor` is the opaque keyset position
 * returned by the previous page. `offset` remains for existing API clients; when
 * a cursor is present it is the page position and offset is ignored.
 */
export const listApplicationsSchema = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(APPLICATION_STATUSES).optional()),
  assigneeUserId: z.preprocess(emptyToUndefined, z.uuid().optional()),
  applicantUserId: z.preprocess(emptyToUndefined, z.uuid().optional()),
  q: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  cursor: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .min(1)
      .max(400)
      .optional()
      .refine((value) => value === undefined || decodeApplicationCursor(value) !== null, {
        message: 'Invalid page cursor.',
      }),
  ),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListApplicationsInput = z.input<typeof listApplicationsSchema>;

/** Add a note to an application. */
export const addNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(['staff', 'shared']).default('staff'),
});
export type AddNoteInput = z.input<typeof addNoteSchema>;
