import { z } from 'zod';
import { isCertificatePrintable, normalizeCertificateText } from './template';

/** Input validation for the certificates domain (zod v4). */

const printableText = (min: number, max: number) =>
  z
    .string()
    .transform((value) => normalizeCertificateText(value).trim())
    .pipe(
      z.string().min(min).max(max).refine(isCertificatePrintable, {
        message: 'Use plain text the certificate font can print.',
      }),
    );

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
 * Publish an organisation certificate template. A new row is stored only when
 * the content hash changes. Logo bytes are optional PNG or JPEG, base64.
 */
export const publishCertificateTemplateSchema = z.object({
  wording: printableText(20, 1200),
  signatoryName: printableText(1, 200),
  signatoryRole: printableText(1, 200),
  logoBase64: z.string().trim().min(1).max(700_000).optional(),
  clearLogo: z.boolean().optional(),
});
export type PublishCertificateTemplateInput = z.infer<
  typeof publishCertificateTemplateSchema
>;

/**
 * Details a verifier typed from the printed certificate.
 * The date of birth is optional and is ignored when the seal has none.
 */
export const checkCertificateHolderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dateOfBirth: z.string().trim().max(32).optional(),
});
export type CheckCertificateHolderInput = z.infer<typeof checkCertificateHolderSchema>;
