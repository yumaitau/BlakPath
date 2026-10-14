/**
 * Evidence status rules — pure, testable, fail-secure.
 *
 * The single source of truth for which evidence states exist, which one is
 * servable, and the upload allow-list (content types and size). Nothing here
 * touches IO, so the worker and the request layer share exactly the same rules.
 */

/** Every evidence status. Mirrors the `evidence_status` pg enum. */
export const EVIDENCE_STATUSES = [
  'pending',
  'quarantined',
  'clean',
  'infected',
  'rejected',
] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Only `clean` evidence may ever be served. Everything else — including a file
 * still awaiting or undergoing a scan — is non-servable. Callers gate every
 * download on this.
 */
export function isServable(status: EvidenceStatus): boolean {
  return status === 'clean';
}

/** Terminal states — the scan lifecycle will not move them again. */
export function isTerminalEvidenceStatus(status: EvidenceStatus): boolean {
  return status === 'clean' || status === 'infected' || status === 'rejected';
}

/** Maximum accepted upload size: 25 MiB. */
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

/**
 * Allow-listed upload content types. Kept deliberately narrow — the documents an
 * applicant supplies are images and office/PDF documents, never executables or
 * archives. The declared type is checked here pre-upload; the REAL type is
 * verified from magic bytes post-upload (see contentTypeAcceptable).
 */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/heic',
  'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** Is a declared content type on the allow-list? */
export function isAllowedContentType(type: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(type);
}

/**
 * File extensions accepted for each allow-listed type. Browsers often report an
 * empty or vendor-specific type (notably for HEIC and legacy Word files), so
 * the upload form falls back to the extension. The server still re-verifies the
 * real type from magic bytes after upload.
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Value for an `<input type="file" accept>` covering the allow-list. */
export const UPLOAD_ACCEPT = [
  ...ALLOWED_CONTENT_TYPES,
  ...Object.keys(EXTENSION_CONTENT_TYPES).map((ext) => `.${ext}`),
].join(',');

/** Lower-cased extension of a file name, without the dot ('' when none). */
function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The content type to declare for a chosen file: the browser-reported type when
 * it is allow-listed, otherwise the type implied by the extension. Returns
 * undefined when neither is acceptable.
 */
export function inferUploadContentType(
  fileName: string,
  browserType: string,
): string | undefined {
  if (isAllowedContentType(browserType)) return browserType;
  return EXTENSION_CONTENT_TYPES[fileExtension(fileName)];
}

/**
 * Pre-upload check for a chosen file, in plain language. Returns a message the
 * person can act on, or null when the file may be uploaded. This is a
 * convenience only; the server enforces the same rules.
 */
export function uploadProblem(file: {
  name: string;
  size: number;
  type: string;
}): string | null {
  if (!inferUploadContentType(file.name, file.type)) {
    return `${file.name} is not a file type we accept. Use a PDF, photo (JPEG, PNG, TIFF or HEIC) or Word document.`;
  }
  if (file.size <= 0) {
    return `${file.name} is empty. Choose the file again or try a different copy.`;
  }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return `${file.name} is larger than 25 MB. Try a smaller scan or photo of the document.`;
  }
  return null;
}

/**
 * The stored object must be exactly the size the client declared, and within
 * the cap. S3 already enforces the signed Content-Length on the presigned PUT;
 * this is the server-side re-check after upload.
 */
export function uploadSizeAcceptable(
  declared: number,
  actual: number | undefined,
): boolean {
  return actual !== undefined && actual === declared && actual <= MAX_EVIDENCE_BYTES;
}

/**
 * Detected types that are acceptable stand-ins for a declared type. `file-type`
 * reports the container rather than the document for some allowed formats:
 *   - legacy Word `.doc` is an MS Compound File (`application/x-cfb`), a
 *     container also used by other formats, so it is only accepted when the
 *     file name also ends in `.doc`;
 *   - HEIC and HEIF share an ISO-BMFF container; the major brand decides which
 *     one is reported (`mif1` → `image/heif`), not the camera or the user.
 */
const EQUIVALENT_DETECTED: Readonly<
  Record<string, ReadonlyArray<{ detected: string; extensions?: readonly string[] }>>
> = {
  'application/msword': [{ detected: 'application/x-cfb', extensions: ['doc'] }],
  'image/heic': [{ detected: 'image/heif' }],
  'image/heif': [{ detected: 'image/heic' }],
};

/**
 * Post-upload verification: resolve the type to store for an upload from what
 * the client declared and what was detected from its magic bytes. Returns the
 * verified, allow-listed content type, or null when the upload must be
 * rejected (a spoofed or disallowed type).
 *
 * The result is the detected type, except that a Compound File container
 * accepted as a `.doc` resolves to `application/msword`. `detected` must be a
 * positive detection; an unidentifiable file is always rejected.
 */
export function verifiedContentType(params: {
  declared: string;
  detected: string | undefined;
  fileName: string;
}): string | null {
  const { declared, detected, fileName } = params;
  if (!isAllowedContentType(declared) || detected === undefined) return null;
  if (detected === declared) return detected;
  const extension = fileExtension(fileName);
  const match = EQUIVALENT_DETECTED[declared]?.find(
    (rule) =>
      rule.detected === detected &&
      (!rule.extensions || rule.extensions.includes(extension)),
  );
  if (!match) return null;
  return isAllowedContentType(detected) ? detected : declared;
}

/** Boolean form of {@link verifiedContentType}. */
export function contentTypeAcceptable(
  declared: string,
  detected: string | undefined,
  fileName = '',
): boolean {
  return verifiedContentType({ declared, detected, fileName }) !== null;
}
