/**
 * Span attributes for one BullMQ job.
 *
 * Only opaque ids. Job data may hold object keys; those stay off the span.
 */

export interface JobSpanInput {
  name?: string;
  data?: {
    organisationId?: string;
    correlationId?: string;
  };
}

export function jobSpanAttributes(
  queue: string,
  job: JobSpanInput,
): Record<string, string> {
  const attributes: Record<string, string> = {
    'messaging.system': 'bullmq',
    'messaging.destination': queue,
    'messaging.operation': 'process',
  };
  if (job.name) attributes['blakpath.job_name'] = job.name;
  if (job.data?.organisationId) {
    attributes['blakpath.organisation_id'] = job.data.organisationId;
  }
  if (job.data?.correlationId) {
    attributes['blakpath.correlation_id'] = job.data.correlationId;
  }
  return attributes;
}
