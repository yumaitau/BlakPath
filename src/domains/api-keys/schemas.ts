import { z } from 'zod';
import { isPermission } from '@/lib/permissions/catalog';

/** Input validation for API-key management (zod v4). */

/**
 * Create an API key. `scopes` must be catalogue permission keys — the key can
 * never be granted a capability that does not exist. (Whether the CREATOR may
 * grant each scope is additionally enforced in the service.)
 */
export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z
      .array(z.string())
      .min(1)
      .max(64)
      .refine((keys) => keys.every((k) => isPermission(k)), {
        message: 'Scopes must be valid permission keys.',
      }),
    /** Days until the key expires. Defaults to 365; capped at 730. */
    expiresInDays: z.coerce.number().int().min(1).max(730).default(365),
    /** Required when any scope is `mcp:*`. */
    purpose: z.string().trim().min(1).max(500).optional(),
    /** Required when any scope is `mcp:*`. Where responses will be sent. */
    destination: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((value, context) => {
    if (!value.scopes.some((scope) => scope.startsWith('mcp:'))) return;
    if (!value.purpose) {
      context.addIssue({
        code: 'custom',
        path: ['purpose'],
        message: 'A purpose is required for MCP scopes.',
      });
    }
    if (!value.destination) {
      context.addIssue({
        code: 'custom',
        path: ['destination'],
        message: 'A destination is required for MCP scopes.',
      });
    }
  });
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;
