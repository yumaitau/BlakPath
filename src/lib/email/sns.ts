import { createHash, createVerify, timingSafeEqual, X509Certificate } from 'node:crypto';

/**
 * SNS message authentication for SES event delivery.
 *
 * Signature versions 1 (RSA-SHA1) and 2 (RSA-SHA256) use the same
 * string-to-sign. The signing certificate must be fetched from
 * `sns.<region>.amazonaws.com` over HTTPS. Callers compare `TopicArn` to the
 * pinned topic after the signature check.
 */

export interface SnsEnvelope {
  Type: string;
  MessageId?: string | null | undefined;
  Token?: string | null | undefined;
  TopicArn?: string | null | undefined;
  Message?: string | null | undefined;
  SubscribeURL?: string | null | undefined;
  Timestamp?: string | null | undefined;
  SignatureVersion?: string | null | undefined;
  Signature?: string | null | undefined;
  SigningCertURL?: string | null | undefined;
  Subject?: string | null | undefined;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const SIGNING_CERT_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;

function asString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.port !== '' && url.port !== '443') return null;
    if (url.hash) return null;
    if (!SNS_HOST.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** SigningCertURL: SNS host, no query, PEM path only. */
export function isAllowedSigningCertUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url || url.search) return false;
  return SIGNING_CERT_PATH.test(url.pathname);
}

/** ConfirmSubscription URL: SNS host, root path, query allowed. */
export function isAllowedSubscribeUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  return url.pathname === '/' || url.pathname === '';
}

function append(parts: string[], key: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  parts.push(`${key}\n${value}\n`);
  return true;
}

/** Canonical string-to-sign. Null when a required field is missing. */
export function snsStringToSign(message: SnsEnvelope): string | null {
  const parts: string[] = [];
  const type = asString(message.Type);
  if (type === 'Notification') {
    if (!append(parts, 'Message', asString(message.Message))) return null;
    if (!append(parts, 'MessageId', asString(message.MessageId))) return null;
    const subject = asString(message.Subject);
    if (subject !== undefined) append(parts, 'Subject', subject);
    if (!append(parts, 'Timestamp', asString(message.Timestamp))) return null;
    if (!append(parts, 'TopicArn', asString(message.TopicArn))) return null;
    if (!append(parts, 'Type', type)) return null;
    return parts.join('');
  }
  if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    if (!append(parts, 'Message', asString(message.Message))) return null;
    if (!append(parts, 'MessageId', asString(message.MessageId))) return null;
    if (!append(parts, 'SubscribeURL', asString(message.SubscribeURL))) return null;
    if (!append(parts, 'Timestamp', asString(message.Timestamp))) return null;
    if (!append(parts, 'Token', asString(message.Token))) return null;
    if (!append(parts, 'TopicArn', asString(message.TopicArn))) return null;
    if (!append(parts, 'Type', type)) return null;
    return parts.join('');
  }
  return null;
}

/**
 * Constant-time shared-secret compare. Digests first so unequal lengths do
 * not throw or exit early inside `timingSafeEqual`.
 */
export function webhookSecretMatches(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length === 0 || provided.length > 1024) return false;
  const actual = createHash('sha256').update(provided, 'utf8').digest();
  const wanted = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actual, wanted);
}

/** True when `pem` signs this envelope. False on any malformed input. */
export function verifySnsSignature(message: SnsEnvelope, pem: string): boolean {
  const version = asString(message.SignatureVersion);
  const signature = asString(message.Signature);
  if (!signature || (version !== '1' && version !== '2')) return false;
  const canonical = snsStringToSign(message);
  if (!canonical) return false;
  try {
    const cert = new X509Certificate(pem);
    const now = Date.now();
    const skew = 5 * 60_000;
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (Number.isNaN(from) || Number.isNaN(to)) return false;
    if (now + skew < from || now - skew > to) return false;
    const algorithm = version === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    return createVerify(algorithm)
      .update(canonical, 'utf8')
      .verify(cert.publicKey, signature, 'base64');
  } catch {
    return false;
  }
}
