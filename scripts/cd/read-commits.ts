import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSemver } from '@/lib/cd/version';

function git(args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion(cwd: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    throw new Error('package.json version is missing');
  }
  const version = (parsed as { version: unknown }).version;
  if (typeof version !== 'string' || !parseSemver(version)) {
    throw new Error('package.json version must be MAJOR.MINOR.PATCH');
  }
  return version;
}

export interface UnreleasedCommits {
  currentVersion: string;
  commit: string;
  messages: string[];
}

/** Tags win over package.json. package.json is only the floor before the first tag. */
export function readUnreleasedCommits(cwd: string): UnreleasedCommits {
  const commit = git(['rev-parse', 'HEAD'], cwd);
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('HEAD is not a full git commit');
  }

  const described = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], cwd);
  let currentVersion = readPackageVersion(cwd);
  let range = 'HEAD';
  if (described) {
    if (!parseSemver(described)) {
      throw new Error(`latest tag ${described} is not semver`);
    }
    currentVersion = described.replace(/^v/, '');
    range = `${described}..HEAD`;
  }
  const raw = git(['log', range, '--format=%B%x1e'], cwd) ?? '';
  const messages = raw
    .split('\u001e')
    .map((message) => message.trim())
    .filter((message) => message.length > 0);

  return { currentVersion, commit, messages };
}
