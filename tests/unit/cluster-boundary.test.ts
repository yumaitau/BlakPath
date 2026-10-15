import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundaryIssues,
  secretSyncResult,
  validatePublicAccessCidrs,
  type BoundaryDocuments,
} from '@/lib/cluster-boundary';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The production view: the base object plus the production overlay patch. */
function production(base: string, patch: string): string {
  return `${read(`infra/k8s/base/${base}`)}\n---\n${read(`infra/k8s/overlays/production/${patch}`)}`;
}

const docs: BoundaryDocuments = {
  externalSecret: production('externalsecret.yaml', 'externalsecret-patch.yaml'),
  secretStore: read('infra/k8s/base/secretstore.yaml'),
  serviceAccounts: production('serviceaccounts.yaml', 'serviceaccount-patch.yaml'),
  kustomization: read('infra/k8s/base/kustomization.yaml'),
  boundaryTemplate: read('infra/aws/eks-boundary.example.yaml'),
  workloadRoles: read('infra/aws/workload-roles.example.yaml'),
  endpointConfig: read('infra/aws/eks-api-endpoint.example.yaml'),
};

const runtimeKey = '/blakpath/production/runtime';

const outsideNamespace = {
  namespace: 'other',
  secretKey: runtimeKey,
  storeKind: 'ClusterSecretStore' as const,
  storeNamespace: null,
  role: 'platform-eso' as const,
};

describe('cluster boundary documents', () => {
  it('matches the namespace, mail, and endpoint contract', () => {
    expect(boundaryIssues(docs)).toEqual([]);
  });

  it('denies the runtime key outside the blakpath namespace', () => {
    expect(secretSyncResult(docs, outsideNamespace)).toBe('access-denied');
  });

  it('denies another namespace that names the blakpath role', () => {
    expect(
      secretSyncResult(docs, {
        namespace: 'other',
        secretKey: runtimeKey,
        storeKind: 'SecretStore',
        storeNamespace: 'other',
        role: 'blakpath-external-secrets',
      }),
    ).toBe('access-denied');
  });

  it('allows the runtime key from the blakpath store', () => {
    expect(
      secretSyncResult(docs, {
        namespace: 'blakpath',
        secretKey: runtimeKey,
        storeKind: 'SecretStore',
        storeNamespace: 'blakpath',
        role: 'blakpath-external-secrets',
      }),
    ).toBe('synced');
  });

  it('does not treat a removed platform deny as AccessDenied', () => {
    const weakened = {
      ...docs,
      boundaryTemplate: docs.boundaryTemplate.replace(
        'DenyPlatformEsoBlakPathSecrets',
        'Removed',
      ),
    };
    expect(secretSyncResult(weakened, outsideNamespace)).toBe('synced');
  });

  it('rejects a world-open API endpoint', () => {
    const issues = boundaryIssues({
      ...docs,
      endpointConfig: [
        'resourcesVpcConfig:',
        '  endpointPublicAccess: true',
        '  endpointPrivateAccess: true',
        '  publicAccessCidrs:',
        '    - 0.0.0.0/0',
      ].join('\n'),
    });
    expect(issues.map(({ key }) => key)).toContain('publicAccessCidrs');
  });

  it('accepts an admin CIDR and rejects every-address CIDRs', () => {
    expect(validatePublicAccessCidrs(['203.0.113.10/32'])).toEqual([]);
    expect(validatePublicAccessCidrs(['0.0.0.0/0', '::/0'])).toHaveLength(2);
  });
});
