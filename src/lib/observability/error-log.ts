/**
 * Safe shape for an operational log line. Callers get a name, an optional
 * stable code, and a message that no longer carries query text or bound
 * values. Stacks and driver payloads stay off the record.
 */
export interface LoggedError {
  name: string;
  code?: string;
  message: string;
}

const SENSITIVE_KEYS = ['params', 'query', 'detail'] as const;
const LABELED_SENSITIVE = /(?:^|\n)[^\n]*\b(?:params|query|detail)\s*:[^\n]*/gi;
const MIN_FRAGMENT = 4;

function addFragment(found: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_FRAGMENT) found.add(value);
    return;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    const text = String(value);
    if (text.length >= MIN_FRAGMENT) found.add(text);
    return;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      addFragment(found, item);
      if (item == null || typeof item === 'object') {
        try {
          parts.push(JSON.stringify(item));
        } catch {
          parts.push('');
        }
      } else {
        parts.push(String(item));
      }
    }
    const joined = parts.join(',');
    if (joined.length >= MIN_FRAGMENT) found.add(joined);
    return;
  }
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text.length >= MIN_FRAGMENT) found.add(text);
    } catch {
      // Cyclic driver payloads are dropped rather than logged.
    }
  }
}

function collectSensitiveFragments(error: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      if (key in record) addFragment(found, record[key]);
    }
    if ('cause' in record) walk(record.cause, depth + 1);
  };
  walk(error, 0);
  return [...found].sort((left, right) => right.length - left.length);
}

function readCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && record.code.length > 0) return record.code;
    if (typeof record.code === 'number') return String(record.code);
    current = record.cause;
  }
  return undefined;
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  if (error.name && error.name !== 'Error') return error.name;
  const constructorName = error.constructor?.name;
  if (constructorName && constructorName !== 'Error') return constructorName;
  return error.name || 'Error';
}

function selectMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const embedsLabeled = /(?:^|\n)\s*(?:params|query|detail)\s*:/i.test(error.message);
  if (embedsLabeled && error.cause instanceof Error && error.cause.message.trim()) {
    return error.cause.message;
  }
  if (embedsLabeled) return 'Database request failed';
  return error.message;
}

function stripFragments(message: string, fragments: string[]): string {
  let result = message;
  for (const fragment of fragments) {
    result = result.split(fragment).join('');
  }
  return result;
}

/**
 * Reduce an unknown thrown value to name, code and a sanitised message.
 * `params`, `query`, `detail` and `cause.detail` are removed, including when
 * a driver has already interpolated them into `message`.
 */
export function serializeLoggedError(error: unknown): LoggedError {
  const name = errorName(error);
  const code = readCode(error);
  const fragments = collectSensitiveFragments(error);
  const stripped = stripFragments(selectMessage(error), fragments)
    .replace(LABELED_SENSITIVE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const message = stripped || 'Unexpected error';
  return code === undefined ? { name, message } : { name, code, message };
}
