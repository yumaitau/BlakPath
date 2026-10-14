/** Checks for the EKS secret-sync, mail, and API endpoint examples. */

export interface BoundaryIssue {
  key: string;
  message: string;
}

export interface BoundaryDocuments {
  externalSecret: string;
  secretStore: string;
  serviceAccounts: string;
  kustomization: string;
  boundaryTemplate: string;
  workloadTrust: string;
  endpointConfig: string;
}

export interface SecretSyncRequest {
  namespace: string;
  secretKey: string;
  storeKind: 'SecretStore' | 'ClusterSecretStore';
  storeNamespace: string | null;
  role: 'blakpath-external-secrets' | 'platform-eso';
}

export type SecretSyncResult = 'synced' | 'access-denied';

const PRODUCTION_SECRET_PREFIX = '/blakpath/production/';
const ESO_SUBJECT = 'system:serviceaccount:blakpath:blakpath-external-secrets';
const WORLD_CIDR = /0\.0\.0\.0\/0|::\/0/;

function hasKind(document: string, kind: string): boolean {
  return new RegExp(`^kind:\\s*${kind}\\s*$`, 'm').test(document);
}

function miss(ok: boolean, key: string, message: string): BoundaryIssue[] {
  return ok ? [] : [{ key, message }];
}

/** Reject an API endpoint that is open to every address. */
export function validatePublicAccessCidrs(cidrs: readonly string[]): BoundaryIssue[] {
  return cidrs
    .filter((cidr) => cidr === '0.0.0.0/0' || cidr === '::/0')
    .map(() => ({
      key: 'publicAccessCidrs',
      message: 'must not allow every address',
    }));
}

function listedCidrs(document: string): string[] {
  return [...document.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1] ?? '');
}

/** Secret-sync controls. Independent of mail and endpoint checks. */
export function secretSyncIssues(docs: BoundaryDocuments): BoundaryIssue[] {
  const storeRef = /kind:\s*SecretStore/.test(docs.externalSecret);
  const namedStore = /name:\s*blakpath-secrets/.test(docs.externalSecret);
  const accountRef = /serviceAccountRef:[\s\S]*name:\s*blakpath-external-secrets/;
  const denyKey = /DenyPlatformEsoAppSecretsKey[\s\S]*kms:Decrypt/;
  const viaService = /DecryptAppSecretsKey[\s\S]*kms:ViaService/;
  const anyResource = /Resource:\s*['"]?\*['"]?/;

  return [
    ...miss(
      hasKind(docs.externalSecret, 'ExternalSecret') && storeRef && namedStore,
      'externalSecret',
      'must use the namespaced SecretStore',
    ),
    ...miss(
      !/kind:\s*ClusterSecretStore/.test(docs.externalSecret),
      'externalSecret',
      'must not use a cluster-wide store',
    ),
    ...miss(
      docs.externalSecret.includes('key: /blakpath/production/runtime'),
      'externalSecret',
      'must read only the production runtime key',
    ),
    ...miss(
      hasKind(docs.secretStore, 'SecretStore') &&
        /namespace:\s*blakpath/.test(docs.secretStore) &&
        !/kind:\s*ClusterSecretStore/.test(docs.secretStore),
      'secretStore',
      'must be a namespaced store in blakpath',
    ),
    ...miss(
      accountRef.test(docs.secretStore) && !/^\s*role:/m.test(docs.secretStore),
      'secretStore',
      'must assume through the blakpath External Secrets service account',
    ),
    ...miss(
      /name:\s*blakpath-external-secrets/.test(docs.serviceAccounts) &&
        /namespace:\s*blakpath/.test(docs.serviceAccounts) &&
        /role\/blakpath-external-secrets/.test(docs.serviceAccounts),
      'serviceAccount',
      'must bind the External Secrets account to its role in blakpath',
    ),
    ...miss(
      docs.kustomization.includes('secretstore.yaml'),
      'kustomization',
      'must include the namespaced store',
    ),
    ...miss(
      docs.boundaryTemplate.includes(ESO_SUBJECT),
      'boundaryTemplate',
      'must pin the External Secrets role to the blakpath service account',
    ),
    ...miss(
      docs.boundaryTemplate.includes('DenyPlatformEsoBlakPathSecrets') &&
        docs.boundaryTemplate.includes('secret:/blakpath/production/*'),
      'boundaryTemplate',
      'must deny the shared role the production folder',
    ),
    ...miss(
      denyKey.test(docs.boundaryTemplate),
      'boundaryTemplate',
      'must deny the shared role decrypt on the app-secrets key',
    ),
    ...miss(
      viaService.test(docs.boundaryTemplate),
      'boundaryTemplate',
      'must allow decrypt only via Secrets Manager',
    ),
    ...miss(
      !anyResource.test(docs.boundaryTemplate),
      'boundaryTemplate',
      'must not grant secret reads on every resource',
    ),
    ...miss(
      docs.workloadTrust.includes('pods.eks.amazonaws.com') &&
        docs.workloadTrust.includes('aws:RequestTag/kubernetes-namespace') &&
        docs.workloadTrust.includes('aws:RequestTag/kubernetes-service-account') &&
        docs.workloadTrust.includes('aws:RequestTag/eks-cluster-name') &&
        docs.workloadTrust.includes('"blakpath"') &&
        !docs.workloadTrust.includes('"*"') &&
        !WORLD_CIDR.test(docs.workloadTrust),
      'workloadTrust',
      'must allow pod identity only for the blakpath service account',
    ),
    ...miss(
      /Namespace:\s*blakpath/.test(docs.boundaryTemplate) &&
        /ServiceAccount:\s*blakpath/.test(docs.boundaryTemplate) &&
        !/DisableSessionTags/.test(docs.boundaryTemplate),
      'podIdentity',
      'must associate only the blakpath namespace and service account',
    ),
  ];
}

function withoutComments(document: string): string {
  return document
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

function endpointIssues(endpointConfig: string): BoundaryIssue[] {
  const config = withoutComments(endpointConfig);
  const publicAccess = /endpointPublicAccess:\s*true/.test(config);
  const issues = [
    ...miss(
      /endpointPrivateAccess:\s*true/.test(config),
      'endpointPrivateAccess',
      'must keep the private API endpoint',
    ),
    ...miss(
      /endpointPublicAccess:\s*(true|false)/.test(config),
      'endpointPublicAccess',
      'must declare public access explicitly',
    ),
  ];
  if (WORLD_CIDR.test(config)) {
    issues.push({ key: 'publicAccessCidrs', message: 'must not allow every address' });
  }
  if (publicAccess) {
    const cidrs = listedCidrs(config);
    issues.push(
      ...miss(
        cidrs.length > 0,
        'publicAccessCidrs',
        'must list admin or CI networks when the public endpoint stays on',
      ),
      ...validatePublicAccessCidrs(cidrs),
    );
  } else {
    issues.push(
      ...miss(
        /endpointPublicAccess:\s*false/.test(config),
        'endpointPublicAccess',
        'must be private unless admin or CI CIDRs are listed',
      ),
    );
  }
  return issues;
}

function mailIssues(boundaryTemplate: string): BoundaryIssue[] {
  return [
    ...miss(
      boundaryTemplate.includes('ses:SendEmail') &&
        boundaryTemplate.includes('ses:FromAddress'),
      'ses',
      'must allow only workload-role send from the application address',
    ),
    ...miss(
      !boundaryTemplate.includes('AmazonSESFullAccess') &&
        !boundaryTemplate.includes('ses:SendRawEmail'),
      'ses',
      'must not grant SES full access or raw SMTP send',
    ),
    ...miss(
      !boundaryTemplate.includes('AWS::IAM::User') &&
        !boundaryTemplate.includes('AWS::IAM::AccessKey'),
      'smtpUser',
      'must not create a standing mail user or access key',
    ),
  ];
}

/** Every boundary document. Empty means the examples match the contract. */
export function boundaryIssues(docs: BoundaryDocuments): BoundaryIssue[] {
  return [
    ...secretSyncIssues(docs),
    ...mailIssues(docs.boundaryTemplate),
    ...endpointIssues(docs.endpointConfig),
  ];
}

/**
 * Model a sync of a `/blakpath/production/` key.
 * Broken secret-sync documents do not count as a deny.
 */
export function secretSyncResult(
  docs: BoundaryDocuments,
  request: SecretSyncRequest,
): SecretSyncResult {
  if (secretSyncIssues(docs).length > 0) return 'synced';
  if (!request.secretKey.startsWith(PRODUCTION_SECRET_PREFIX)) return 'access-denied';
  const allowed =
    request.namespace === 'blakpath' &&
    request.storeKind === 'SecretStore' &&
    request.storeNamespace === 'blakpath' &&
    request.role === 'blakpath-external-secrets';
  return allowed ? 'synced' : 'access-denied';
}
