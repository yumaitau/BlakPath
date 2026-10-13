import { build } from 'esbuild';
import path from 'node:path';

const root = process.cwd();

/** Rewrite `@/` and `@worker/` without treating `@scope/pkg` as an alias. */
const pathAlias = {
  name: 'path-alias',
  setup(b) {
    b.onResolve({ filter: /^@(?:worker\/|\/)/ }, (args) => {
      if (args.pluginData?.aliasResolved) return null;
      const target = args.path.startsWith('@worker/')
        ? path.join(root, 'worker', args.path.slice('@worker/'.length))
        : path.join(root, 'src', args.path.slice(2));
      return b.resolve(target, {
        resolveDir: root,
        kind: args.kind,
        pluginData: { aliasResolved: true },
      });
    });
  },
};

await build({
  entryPoints: ['worker/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/worker.js',
  packages: 'external',
  plugins: [pathAlias],
  legalComments: 'none',
  logLevel: 'info',
});
