/**
 * Change metadata for an intake update.
 *
 * Personal values (the applicant's name, intake answers) are not arguments.
 * The trail records which fields changed, plus operational fields such as
 * priority that are not personal information.
 */
export function applicationIntakeAuditMeta(input: {
  readonly beforePriority: string;
  readonly afterPriority: string;
  readonly changed: readonly string[];
}): {
  before: { data: { priority: string }; allow: readonly string[] };
  after: { data: { changed: string[]; priority: string }; allow: readonly string[] };
} {
  return {
    before: { data: { priority: input.beforePriority }, allow: ['priority'] },
    after: {
      data: { changed: [...input.changed], priority: input.afterPriority },
      allow: ['changed', 'priority'],
    },
  };
}
