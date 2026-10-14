import { z } from 'zod';

/** Input validation for the certificates domain (zod v4). */

/** Generate a certificate from a finalised, confirmed decision. */
export const generateCertificateSchema = z.object({
  decisionId: z.uuid(),
});
export type GenerateCertificateInput = z.input<typeof generateCertificateSchema>;

/** Revoke an issued certificate, recording why. */
export const revokeCertificateSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
export type RevokeCertificateInput = z.input<typeof revokeCertificateSchema>;

/**
 * Details a verifier typed from the printed certificate.
 * The date of birth is optional and is ignored when the seal has none.
 */
export const checkCertificateHolderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dateOfBirth: z.string().trim().max(32).optional(),
});
export type CheckCertificateHolderInput = z.infer<typeof checkCertificateHolderSchema>;
