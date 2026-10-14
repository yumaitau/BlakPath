import { z } from 'zod';
import { webhookUrlIssue } from './destination';
import { isWebhookEvent } from './events';

/** Input validation for webhook endpoint management (zod v4). */

export const createEndpointSchema = z.object({
  /**
   * Absolute public HTTPS URL. Names that still need DNS are checked again
   * in the service before anything is stored.
   */
  url: z.string().refine((value) => webhookUrlIssue(value) === null, {
    message: 'URL must be a public HTTPS endpoint.',
  }),
  events: z
    .array(z.string())
    .min(1)
    .max(32)
    .refine((evts) => evts.every(isWebhookEvent), {
      message: 'Unknown webhook event type.',
    }),
});
export type CreateEndpointInput = z.input<typeof createEndpointSchema>;
