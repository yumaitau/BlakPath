/**
 * Best-effort scrub for free-text operational errors.
 *
 * Structured logs already redact known keys (see `logger.ts`). Error messages
 * and stack traces are unstructured, so this pass strips the patterns that
 * must never reach CloudWatch: addresses, bearer material, and URLs that may
 * embed presigned query secrets. Opaque ids are left intact.
 */

const SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]'],
  [/\bbp_[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]'],
  [
    /\b(?:bearer|token|password|secret|authorization)\b\s*[:=]\s*\S+/gi,
    '[redacted-secret]',
  ],
  [/(?:https?:\/\/|postgres(?:ql)?:\/\/|rediss?:\/\/)\S+/gi, '[redacted-url]'],
  [/\+\d[\d\s().-]{7,}\d\b/g, '[redacted-phone]'],
];

const MAX_LENGTH = 2_000;

/** Return a length-capped copy safe to put in an operational log. */
export function scrubText(value: string): string {
  let next = value;
  for (const [pattern, replacement] of SCRUBBERS) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, replacement);
  }
  return next.length > MAX_LENGTH ? `${next.slice(0, MAX_LENGTH)}…` : next;
}

/** Fields safe to attach when an Error must be logged. No raw object. */
export function scrubErrorForLog(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: scrubText(error.message) };
  }
  return { name: 'Error', message: 'non-error rejection' };
}
