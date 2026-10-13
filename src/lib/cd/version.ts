/** Semver planning from conventional commits. The git tag is the release record. */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type VersionBump = 'major' | 'minor' | 'patch';

const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONVENTIONAL = /^([a-z]+)(?:\([^)]+\))?(!)?: (.+)$/;
const BREAKING_FOOTER = /(?:^|\n)BREAKING[ -]CHANGE:/;

export function parseSemver(value: string): SemVer | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatSemver(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function formatReleaseTag(version: SemVer): string {
  return `v${formatSemver(version)}`;
}

/** Non-conventional commits still ship, so they take a patch. Empty text does not. */
export function classifyCommit(message: string): VersionBump | null {
  const subject = commitSubject(message);
  if (!subject) return null;
  const header = CONVENTIONAL.exec(subject);
  const breaking = Boolean(header?.[2]) || BREAKING_FOOTER.test(message);
  if (breaking) return 'major';
  if (header?.[1] === 'feat') return 'minor';
  return 'patch';
}

export function foldBump(bumps: readonly VersionBump[]): VersionBump {
  if (bumps.includes('major')) return 'major';
  if (bumps.includes('minor')) return 'minor';
  return 'patch';
}

export function bumpVersion(current: SemVer, bump: VersionBump): SemVer {
  if (bump === 'major') return { major: current.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor')
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

export interface ReleasePlan {
  version: string;
  tag: string;
  bump: VersionBump;
  commitCount: number;
}

export function planRelease(
  currentVersion: string,
  messages: readonly string[],
): ReleasePlan {
  const current = parseSemver(currentVersion);
  if (!current) {
    throw new Error('current version must be MAJOR.MINOR.PATCH');
  }
  const bumps: VersionBump[] = [];
  for (const message of messages) {
    const bump = classifyCommit(message);
    if (bump) bumps.push(bump);
  }
  if (bumps.length === 0) {
    throw new Error('no unreleased commits; refusing to cut a production tag');
  }
  const bump = foldBump(bumps);
  const next = bumpVersion(current, bump);
  return {
    version: formatSemver(next),
    tag: formatReleaseTag(next),
    bump,
    commitCount: bumps.length,
  };
}

export function commitSubject(message: string): string {
  const line = message.split('\n').find((entry) => entry.trim().length > 0);
  return line?.trim() ?? '';
}

export interface ReleaseNotesInput {
  tag: string;
  commit: string;
  webImage: string;
  workerImage: string;
  messages: readonly string[];
  subjectLimit?: number;
  maxLength?: number;
}

/**
 * Release notes name the tag, the built commit, and both digests.
 * Commit bodies are omitted so a footer cannot leak into the public release.
 */
export function renderReleaseNotes(input: ReleaseNotesInput): string {
  const limit = input.subjectLimit ?? 50;
  const groups: Record<'breaking' | 'features' | 'fixes' | 'other', string[]> = {
    breaking: [],
    features: [],
    fixes: [],
    other: [],
  };
  for (const message of input.messages) {
    const subject = commitSubject(message);
    const bump = classifyCommit(message);
    if (!subject || !bump) continue;
    const header = CONVENTIONAL.exec(subject);
    if (bump === 'major') groups.breaking.push(subject);
    else if (header?.[1] === 'feat') groups.features.push(subject);
    else if (header?.[1] === 'fix') groups.fixes.push(subject);
    else groups.other.push(subject);
  }

  const lines = [
    `## ${input.tag}`,
    '',
    `Production deploy of \`${input.commit}\`. Images are digest-pinned.`,
    '',
    `- Web: \`${input.webImage}\``,
    `- Worker: \`${input.workerImage}\``,
    `- Release gate image: \`${input.workerImage}\``,
    '',
    'Verify provenance:',
    '',
    '```',
    `gh attestation verify oci://${input.webImage} --repo yumaitau/BlakPath --signer-workflow yumaitau/BlakPath/.github/workflows/cd.yml`,
    `gh attestation verify oci://${input.workerImage} --repo yumaitau/BlakPath --signer-workflow yumaitau/BlakPath/.github/workflows/cd.yml`,
    '```',
    '',
  ];

  appendGroup(lines, 'Breaking', groups.breaking, limit);
  appendGroup(lines, 'Features', groups.features, limit);
  appendGroup(lines, 'Fixes', groups.fixes, limit);
  appendGroup(lines, 'Other', groups.other, limit);

  let notes = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!notes.endsWith('\n')) notes += '\n';
  const cap = input.maxLength ?? 20_000;
  if (notes.length > cap) {
    notes = `${notes.slice(0, Math.max(0, cap - 40)).trimEnd()}\n\n… release notes truncated.\n`;
  }
  return notes;
}

function appendGroup(
  lines: string[],
  title: string,
  subjects: readonly string[],
  limit: number,
): void {
  if (subjects.length === 0) return;
  lines.push(`### ${title}`, '');
  const shown = subjects.slice(0, limit);
  for (const subject of shown) lines.push(`- ${subject}`);
  if (subjects.length > shown.length) {
    lines.push(`- … ${subjects.length - shown.length} older commits omitted`);
  }
  lines.push('');
}
