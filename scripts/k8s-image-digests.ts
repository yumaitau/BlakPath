import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** imageDigest shape ECR returns. Mutable tags and git SHAs do not match. */
export const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Stand-in written into the pin file when the ECR imageDigest is not known.
 * It is 64 hex characters so kustomize will render `@sha256:…`, and it is not
 * an image that exists. The audit rejects it until a human replaces it.
 */
export const UNRESOLVED_DIGEST = `sha256:${'0'.repeat(64)}`;

export interface ImagePin {
  file: string;
  name: string;
  digest?: string;
  newTag?: string;
  newName?: string;
}

export interface ContainerImage {
  file: string;
  container: string;
  image: string;
  resolved: string;
}

export interface K8sImageAudit {
  issues: string[];
  pins: ImagePin[];
  containers: ContainerImage[];
}

interface SourceFile {
  path: string;
  text: string;
}

function displayPath(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function stripInlineComment(line: string): string {
  return line.replace(/\s+#.*$/, '');
}

/** Kustomize `images:` entries. Only `kustomization.yaml` is consulted. */
export function parseImagePins(file: string, text: string): ImagePin[] {
  const pins: ImagePin[] = [];
  let inImages = false;
  let current: ImagePin | undefined;

  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const line = stripInlineComment(raw);
    if (!inImages) {
      if (/^images:\s*$/.test(line)) inImages = true;
      continue;
    }
    if (line.trim() !== '' && /^\S/.test(line)) {
      inImages = false;
      current = undefined;
      if (/^images:\s*$/.test(line)) inImages = true;
      continue;
    }

    const name = line.match(/^\s*-\s+name:\s*(['"]?)(.+?)\1\s*$/);
    if (name?.[2]) {
      current = { file, name: name[2] };
      pins.push(current);
      continue;
    }
    if (!current) continue;

    const field = line.match(/^\s+(digest|newTag|newName):\s*(['"]?)(.+?)\2\s*$/);
    if (!field?.[1] || !field[3]) continue;
    if (field[1] === 'digest') current.digest = field[3];
    else if (field[1] === 'newTag') current.newTag = field[3];
    else current.newName = field[3];
  }

  return pins;
}

function fieldAt(
  line: string,
  field: 'image' | 'name',
): { indent: number; value: string } | undefined {
  const match = line.match(
    new RegExp(String.raw`^(\s*)(?:-\s+)?${field}:\s*(['"]?)(.+?)\2\s*$`),
  );
  if (!match?.[1] || !match[3]) return undefined;
  const dashed = /^\s*-\s+/.test(line);
  return { indent: match[1].length + (dashed ? 2 : 0), value: match[3] };
}

/**
 * Container `name` / `image` pairs.
 * Kustomize sorts keys, so `image` may come before `name`, and the list dash
 * may sit on whichever key sorts first. Nested names (ports, env refs) are
 * indented further. `imagePullPolicy` is not an image.
 */
export function parseContainerImages(
  file: string,
  text: string,
): Array<Omit<ContainerImage, 'resolved'>> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : stripInlineComment(line)));
  const containers: Array<Omit<ContainerImage, 'resolved'>> = [];

  const siblingDash = (line: string, keyIndent: number) => {
    const match = line.match(/^(\s*)-\s+/);
    return match?.[1]?.length === keyIndent - 2;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const image = fieldAt(line, 'image');
    if (!image) continue;

    let start = index;
    if (!/^\s*-\s+image:/.test(line)) {
      while (start > 0) {
        const previous = lines[start - 1] ?? '';
        if (previous.trim() === '') {
          start -= 1;
          continue;
        }
        if (siblingDash(previous, image.indent)) {
          start -= 1;
          break;
        }
        const indent = previous.match(/^\s*/)?.[0].length ?? 0;
        if (indent < image.indent) break;
        start -= 1;
      }
    }

    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end] ?? '';
      if (next.trim() === '') {
        end += 1;
        continue;
      }
      if (siblingDash(next, image.indent)) break;
      const indent = next.match(/^\s*/)?.[0].length ?? 0;
      if (indent < image.indent) break;
      end += 1;
    }

    let container = '(unknown)';
    for (const line of lines.slice(start, end)) {
      const name = fieldAt(line, 'name');
      if (name?.indent === image.indent) {
        container = name.value;
        break;
      }
    }
    containers.push({ file, container, image: image.value });
  }

  return containers;
}

export function resolveImage(image: string, pins: readonly ImagePin[]): string {
  const pin = pins.find(
    (entry) =>
      image === entry.name ||
      image.startsWith(`${entry.name}@`) ||
      image.startsWith(`${entry.name}:`),
  );
  if (!pin) return image;
  const name = pin.newName ?? pin.name;
  if (pin.digest) return `${name}@${pin.digest}`;
  if (pin.newTag) return `${name}:${pin.newTag}`;
  return name;
}

function digestOf(image: string): string | undefined {
  const at = image.lastIndexOf('@');
  if (at === -1) return undefined;
  return image.slice(at + 1);
}

function isResolvedDigest(digest: string | undefined): digest is string {
  return (
    digest !== undefined && digest !== UNRESOLVED_DIGEST && SHA256_DIGEST.test(digest)
  );
}

/**
 * Rules:
 * - one kustomize `images:` list is the only version pin
 * - that list uses `digest`, never `newTag`
 * - a digest is `sha256:` plus 64 hex characters, and not the zero placeholder
 * - a container `image:` is the repository name, or the same `@sha256:` the pin sets
 * - mutable `:tag` references fail even when a pin would overwrite them
 */
export function auditImageSources(
  root: string,
  files: readonly SourceFile[],
): K8sImageAudit {
  const pins: ImagePin[] = [];
  const pinFiles: string[] = [];
  const found: Array<Omit<ContainerImage, 'resolved'>> = [];

  for (const file of files) {
    if (path.basename(file.path) === 'kustomization.yaml') {
      const parsed = parseImagePins(file.path, file.text);
      if (parsed.length > 0) {
        pins.push(...parsed);
        pinFiles.push(file.path);
      }
    }
    found.push(...parseContainerImages(file.path, file.text));
  }

  const issues: string[] = [];
  if (pinFiles.length !== 1) {
    const where = pinFiles.map((file) => displayPath(file, root)).join(', ') || 'none';
    issues.push(`expected one kustomize images pin, found ${pinFiles.length} (${where})`);
  }

  const pinByName = new Map<string, ImagePin>();
  for (const pin of pins) {
    const where = `${displayPath(pin.file, root)}: ${pin.name}`;
    if (pin.newTag)
      issues.push(`${where} sets newTag (${pin.newTag}); pin a digest instead`);
    if (pinByName.has(pin.name)) issues.push(`${where} is pinned more than once`);
    pinByName.set(pin.name, pin);
    if (!isResolvedDigest(pin.digest)) {
      const foundDigest = pin.digest ?? 'missing';
      const why =
        pin.digest === UNRESOLVED_DIGEST
          ? 'unresolved placeholder'
          : 'not an ECR imageDigest';
      issues.push(`${where} digest is ${why} (${foundDigest})`);
    }
  }

  const containers: ContainerImage[] = [];
  for (const container of found) {
    const where = `${displayPath(container.file, root)}: ${container.container}`;
    const resolved = resolveImage(container.image, pins);
    containers.push({ ...container, resolved });

    const inlineDigest = digestOf(container.image);
    if (inlineDigest !== undefined) {
      if (!isResolvedDigest(inlineDigest)) {
        issues.push(`${where} image digest is not resolved (${container.image})`);
      }
      const pin = pinByName.get(
        container.image.slice(0, container.image.lastIndexOf('@')),
      );
      if (pin?.digest && inlineDigest !== pin.digest) {
        issues.push(`${where} image digest disagrees with the kustomize pin`);
      }
      continue;
    }

    if (container.image.includes(':')) {
      issues.push(`${where} image uses a mutable tag (${container.image})`);
      continue;
    }

    if (!pinByName.has(container.image)) {
      issues.push(`${where} image has no digest pin (${container.image})`);
    }
  }

  return { issues, pins, containers };
}

export function auditK8sDirectory(root: string): K8sImageAudit {
  return auditImageSources(root, readYamlFiles(root));
}

/** Every rendered `image:` must be the pin resolver's digest, not a tag. */
export function auditRenderedImages(
  rendered: string,
  containers: readonly ContainerImage[],
): string[] {
  const renderedContainers = parseContainerImages('rendered', rendered);
  const issues: string[] = [];
  const byName = new Map(
    renderedContainers.map((container) => [container.container, container.image]),
  );
  const seen = new Set<string>();

  for (const container of containers) {
    const actual = byName.get(container.container);
    if (actual === undefined) {
      issues.push(`rendered manifest has no image for ${container.container}`);
      continue;
    }
    seen.add(container.container);
    if (actual !== container.resolved) {
      issues.push(
        `rendered ${container.container} image is ${actual}; kustomize pin resolves to ${container.resolved}`,
      );
    }
    if (!SHA256_DIGEST.test(digestOf(actual) ?? '')) {
      issues.push(
        `rendered ${container.container} image lacks a sha256 digest (${actual})`,
      );
    }
  }

  for (const image of renderedContainers) {
    if (seen.has(image.container)) continue;
    if (!SHA256_DIGEST.test(digestOf(image.image) ?? '')) {
      issues.push(`rendered image lacks a sha256 digest (${image.image})`);
    }
  }

  return issues;
}

/**
 * Directories under `root` (root first) whose kustomization.yaml is a
 * `Kustomization`, not a `Component`. Each is rendered on its own.
 */
export function kustomizationRoots(root: string): string[] {
  return readYamlFiles(root)
    .filter(
      (file) =>
        path.basename(file.path) === 'kustomization.yaml' &&
        /^kind:\s*Kustomization\s*$/m.test(file.text),
    )
    .map((file) => path.dirname(file.path))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function readYamlFiles(root: string): SourceFile[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files.sort().map((file) => ({ path: file, text: readFileSync(file, 'utf8') }));
}
