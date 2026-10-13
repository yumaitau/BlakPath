import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One exported async domain function. The cross-tenant suite calls each of these. */
export interface DomainFunction {
  readonly file: string;
  readonly name: string;
  readonly specifier: string;
  readonly params: readonly ParsedParam[];
}

export interface ParsedParam {
  readonly name: string;
  readonly optional: boolean;
  readonly annotation: string;
}

export function domainFunctionId(fn: Pick<DomainFunction, 'file' | 'name'>): string {
  return `${fn.file}#${fn.name}`;
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Parameters of `export async function <name>`, split on top-level commas. */
export function parameterList(source: string, name: string): ParsedParam[] {
  const start = source.search(new RegExp(`export async function ${name}\\b`));
  if (start < 0) return [];
  const open = source.indexOf('(', start);
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const inside = source.slice(open + 1, end).trim();
  if (!inside) return [];

  const parts: string[] = [];
  let current = '';
  let nest = 0;
  for (const ch of inside) {
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') nest += 1;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']')
      nest = Math.max(0, nest - 1);
    if (ch === ',' && nest === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map((part) => {
    const cleaned = part.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const match = /^(\w+)/.exec(cleaned);
    const paramName = match?.[1] ?? 'arg';
    const optional = /\?/.test(cleaned.split('=')[0] ?? cleaned) || cleaned.includes('=');
    const colon = cleaned.indexOf(':');
    const annotation =
      colon >= 0 ? (cleaned.slice(colon + 1).split('=')[0] ?? '').trim() : '';
    return { name: paramName, optional, annotation };
  });
}

/** Every `export async function` under src/domains, sorted. */
export function listDomainFunctions(root = process.cwd()): DomainFunction[] {
  const dir = join(root, 'src/domains');
  const functions: DomainFunction[] = [];
  for (const path of filesUnder(dir)) {
    const source = readFileSync(path, 'utf8');
    const file = relative(root, path).split('\\').join('/');
    const specifier = `@/${file.replace(/^src\//, '').replace(/\.ts$/, '')}`;
    for (const match of source.matchAll(/export async function (\w+)/g)) {
      const name = match[1];
      if (!name) continue;
      functions.push({
        file,
        name,
        specifier,
        params: parameterList(source, name),
      });
    }
  }
  functions.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return functions;
}
