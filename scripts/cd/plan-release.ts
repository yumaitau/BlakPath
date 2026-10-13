/* eslint-disable no-restricted-properties -- writes the Actions output file when present. */
import { appendFileSync } from 'node:fs';
import { planRelease } from '@/lib/cd/version';
import { readUnreleasedCommits } from './read-commits';

const cwd = process.cwd();
const { currentVersion, messages } = readUnreleasedCommits(cwd);
const plan = planRelease(currentVersion, messages);
const output = JSON.stringify(plan);
process.stdout.write(`${output}\n`);

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  appendFileSync(githubOutput, `tag=${plan.tag}\nversion=${plan.version}\n`);
}
