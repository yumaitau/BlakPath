import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Mutation and its audit must share one transaction.
 *
 * Direct calls are those in a function body, not calls inside a nested
 * function. A transaction callback is its own function: the write and the
 * audit live there and pass `tx`. A success audit beside `.transaction(`
 * (the old "commit, then audit" shape) is a violation. A `denied` audit may
 * stay outside — it records a refusal after rollback.
 */

const SRC = path.resolve(process.cwd(), 'src');
const AUDIT_FNS = new Set([
  'recordAudit',
  'recordPlatformAudit',
  'systemAudit',
  'sysAudit',
]);
const MUTATIONS = new Set(['insert', 'update', 'delete']);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function isAuditCall(node: ts.CallExpression): boolean {
  const name = calleeName(node.expression);
  return name !== undefined && AUDIT_FNS.has(name);
}

function isMutationCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    MUTATIONS.has(node.expression.name.text)
  );
}

function isTransactionCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'transaction'
  );
}

function passesTx(node: ts.CallExpression): boolean {
  return node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === 'tx');
}

function hasTxParam(fn: ts.FunctionLikeDeclaration): boolean {
  return fn.parameters.some(
    (param) => ts.isIdentifier(param.name) && param.name.text === 'tx',
  );
}

function resultLiteral(node: ts.CallExpression): string | undefined {
  for (const arg of node.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      if (prop.name.text !== 'result') continue;
      if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
    }
  }
  return undefined;
}

function functionLabel(fn: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  let name = 'anonymous';
  if (
    (ts.isFunctionDeclaration(fn) ||
      ts.isMethodDeclaration(fn) ||
      ts.isConstructorDeclaration(fn)) &&
    fn.name
  ) {
    name = fn.name.getText(source);
  } else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    name = fn.parent.name.text;
  }
  const { line } = source.getLineAndCharacterOfPosition(fn.getStart(source));
  return `${name}:${line + 1}`;
}

function directCalls(fn: ts.FunctionLikeDeclaration): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return calls;
}

function violationsInSource(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const rel = path.relative(process.cwd(), fileName);
  const violations: string[] = [];
  for (const fn of functions) {
    const calls = directCalls(fn);
    const audits = calls.filter(isAuditCall);
    const label = `${rel}:${functionLabel(fn, source)}`;

    if (hasTxParam(fn)) {
      for (const call of audits) {
        if (!passesTx(call)) {
          violations.push(
            `${label}: ${calleeName(call.expression)} must pass tx (function parameter tx)`,
          );
        }
      }
    }

    if (calls.some(isMutationCall) && audits.length > 0) {
      for (const call of audits) {
        if (!passesTx(call)) {
          violations.push(
            `${label}: ${calleeName(call.expression)} shares a function with a write and must pass tx`,
          );
        }
      }
    }

    if (calls.some(isTransactionCall)) {
      for (const call of audits) {
        if (resultLiteral(call) === 'denied') continue;
        violations.push(
          `${label}: ${calleeName(call.expression)} sits outside the transaction callback`,
        );
      }
    }
  }
  return violations;
}

function violationsIn(file: string): string[] {
  return violationsInSource(file, readFileSync(file, 'utf8'));
}

describe('audit transaction boundary', () => {
  it('joins every mutation audit to the caller transaction', () => {
    const violations = walk(SRC).flatMap(violationsIn);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('flags a success audit left outside the business transaction', () => {
    const violations = violationsInSource(
      'bad.ts',
      `async function commitThenAudit() {
        await db.transaction(async (tx) => {
          await tx.update(rows).set({ status: 'ready' });
        });
        await recordAudit({ action: 'export.generated', result: 'success' });
      }`,
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('flags a write and audit that do not share tx', () => {
    const violations = violationsInSource(
      'split.ts',
      `async function split() {
        await db.insert(rows).values({ id: '1' });
        await recordAudit({ action: 'membership.invited', result: 'success' });
      }`,
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('allows a denied audit outside and a success audit that passes tx', () => {
    const violations = violationsInSource(
      'ok.ts',
      `async function joined() {
        await recordAudit({ action: 'membership.invited', result: 'denied' });
        await db.transaction(async (tx) => {
          await tx.insert(rows).values({ id: '1' });
          await recordAudit({ action: 'membership.invited', result: 'success' }, tx);
        });
      }`,
    );
    expect(violations).toEqual([]);
  });
});
