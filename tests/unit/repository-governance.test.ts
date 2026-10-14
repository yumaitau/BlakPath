import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('repository governance', () => {
  it('licenses source under AGPL-3.0-only and points security reports at SECURITY.md', () => {
    const license = read('LICENSE');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');

    const pkg = JSON.parse(read('package.json')) as { license: string };
    expect(pkg.license).toBe('AGPL-3.0-only');

    const readme = read('README.md');
    expect(readme).toContain('AGPL-3.0-only');
    expect(readme).toContain('](SECURITY.md)');
    expect(readme).not.toContain(
      'security issues via the process in\n  `docs/operations-runbook.md`',
    );
    expect(read('docs/operations-runbook.md')).toContain('](../SECURITY.md)');
    expect(read('CONTRIBUTING.md')).toContain('BlakPath never determines Aboriginality.');
  });

  it('states private reporting, response targets, safe harbour and supported versions', () => {
    const policy = read('SECURITY.md');
    expect(policy).toContain('private vulnerability reporting');
    expect(policy).toContain('## Safe harbour');
    expect(policy).toContain('## Supported versions');
    expect(policy).toContain('3 business days');
    expect(policy).toContain('10 business days');
    expect(policy).toContain('90 days from assessment');
    expect(read('.github/ISSUE_TEMPLATE/config.yml')).toContain(
      'https://github.com/yumaitau/BlakPath/security/advisories/new',
    );
  });

  it('assigns code owners to sensitive paths', () => {
    const owners = read('.github/CODEOWNERS');
    for (const path of [
      '/src/lib/auth/',
      '/src/lib/tenancy/',
      '/src/lib/permissions/',
      '/src/db/migrations/',
      '/infra/',
      '/.github/',
    ]) {
      expect(owners).toContain(path);
    }
    for (const path of ['/LICENSE', '/SECURITY.md', '/CONTRIBUTING.md']) {
      expect(owners).toContain(path);
    }
    expect(owners).toContain('@jusso-dev');
    expect(read('CONTRIBUTING.md')).toContain('](docs/branch-protection.md)');
  });

  it('groups dependency updates and asks the identity question', () => {
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot).toMatch(/package-ecosystem:\s*"?npm"?/);
    expect(dependabot).toMatch(/package-ecosystem:\s*"?docker"?/);
    expect(dependabot).toMatch(/package-ecosystem:\s*"?github-actions"?/);
    expect(dependabot).toContain('groups:');

    const identity = 'does this change let software determine identity? → no';
    expect(read('.github/PULL_REQUEST_TEMPLATE.md')).toContain(identity);
    expect(read('.github/ISSUE_TEMPLATE/feature_request.yml')).toContain(identity);
  });
});
