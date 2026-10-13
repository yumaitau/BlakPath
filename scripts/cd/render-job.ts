import { parseArgs } from 'node:util';
import { digestImageRef } from '@/lib/cd/images';
import { renderCdJob, type ClusterJobStep } from '@/lib/cd/jobs';

const { values } = parseArgs({
  options: {
    step: { type: 'string' },
    name: { type: 'string' },
    namespace: { type: 'string' },
    repository: { type: 'string' },
    digest: { type: 'string' },
  },
});

const step = values.step;
const name = values.name;
const namespace = values.namespace;
const repository = values.repository;
const digest = values.digest;
if (!step || !name || !namespace || !repository || !digest) {
  throw new Error('usage: render-job.ts --step --name --namespace --repository --digest');
}
if (step !== 'release-gate' && step !== 'migrate') {
  throw new Error('step must be release-gate or migrate');
}

const jobStep: ClusterJobStep = step;
process.stdout.write(
  renderCdJob({
    step: jobStep,
    name,
    namespace,
    image: digestImageRef(repository, digest),
  }),
);
