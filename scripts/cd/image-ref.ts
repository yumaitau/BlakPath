import { parseArgs } from 'node:util';
import { digestImageRef } from '@/lib/cd/images';

const { values } = parseArgs({
  options: {
    repository: { type: 'string' },
    digest: { type: 'string' },
  },
});

if (!values.repository || !values.digest) {
  throw new Error('usage: image-ref.ts --repository --digest');
}
process.stdout.write(`${digestImageRef(values.repository, values.digest)}\n`);
