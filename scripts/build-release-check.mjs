import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'release-check');

function transpile(fileName, source) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const lib = transpile(
  'production-readiness.ts',
  readFileSync(join(root, 'src/lib/production-readiness.ts'), 'utf8'),
);
const cli = transpile(
  'check-production-readiness.ts',
  readFileSync(join(root, 'scripts/check-production-readiness.ts'), 'utf8').replace(
    "from '@/lib/production-readiness'",
    "from './production-readiness.cjs'",
  ),
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'production-readiness.cjs'), lib);
writeFileSync(join(outDir, 'release-check.cjs'), cli);
