import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertProductionReleaseRecord, digestImageRef } from '@/lib/cd/images';
import { planRelease, renderReleaseNotes } from '@/lib/cd/version';
import { readUnreleasedCommits } from './read-commits';

const { values } = parseArgs({
  options: {
    'web-repository': { type: 'string' },
    'worker-repository': { type: 'string' },
    'web-digest': { type: 'string' },
    'worker-digest': { type: 'string' },
    'expect-tag': { type: 'string' },
    'out-dir': { type: 'string' },
  },
});

const webRepository = values['web-repository'];
const workerRepository = values['worker-repository'];
const webDigest = values['web-digest'];
const workerDigest = values['worker-digest'];
const expectTag = values['expect-tag'];
const outDir = values['out-dir'];
if (
  !webRepository ||
  !workerRepository ||
  !webDigest ||
  !workerDigest ||
  !expectTag ||
  !outDir
) {
  throw new Error(
    'usage: write-release.ts --web-repository --worker-repository --web-digest --worker-digest --expect-tag --out-dir',
  );
}

const { currentVersion, commit, messages } = readUnreleasedCommits(process.cwd());
const plan = planRelease(currentVersion, messages);
if (plan.tag !== expectTag) {
  throw new Error(`planned tag ${plan.tag} does not match ${expectTag}`);
}

const webImage = digestImageRef(webRepository, webDigest);
const workerImage = digestImageRef(workerRepository, workerDigest);
const record = {
  tag: plan.tag,
  commit,
  webImage,
  workerImage,
  releaseGateImage: workerImage,
};
assertProductionReleaseRecord(record);

const notes = renderReleaseNotes({
  tag: plan.tag,
  commit,
  webImage,
  workerImage,
  messages,
});

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'release-record.json'),
  `${JSON.stringify(record, null, 2)}\n`,
);
writeFileSync(join(outDir, 'notes.md'), notes);
process.stdout.write(`${plan.tag} ${commit}\n`);
