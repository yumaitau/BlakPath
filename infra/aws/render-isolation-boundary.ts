import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsolationBoundaryTemplate } from './isolation-boundary';

const destination = join(
  dirname(fileURLToPath(import.meta.url)),
  'isolation-boundary.json',
);
writeFileSync(
  destination,
  `${JSON.stringify(buildIsolationBoundaryTemplate(), null, 2)}\n`,
);
