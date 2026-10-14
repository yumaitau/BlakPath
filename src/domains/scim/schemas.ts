import { z } from 'zod';

/** SCIM User payload accepted from an IdP (subset of core + groups). */
export const scimUserSchema = z.object({
  userName: z.email().max(320),
  active: z.boolean().optional(),
  name: z
    .object({
      givenName: z.string().max(200).optional(),
      familyName: z.string().max(200).optional(),
      formatted: z.string().max(400).optional(),
    })
    .optional(),
  groups: z.array(z.object({ display: z.string().max(200) })).optional(),
  entitlements: z.array(z.object({ value: z.string().max(200) })).optional(),
});

export type ScimUserInput = z.input<typeof scimUserSchema>;

/** Create a per-organisation SCIM credential. The raw token is returned once. */
export const createScimCredentialSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Explicit opt-in. Default false: cannot assign `organisation-admin`. */
  allowOrganisationAdmin: z.boolean().default(false),
  /** Days until the credential expires. Defaults to 365; capped at 730. */
  expiresInDays: z.coerce.number().int().min(1).max(730).default(365),
});

export type CreateScimCredentialInput = z.input<typeof createScimCredentialSchema>;
