/**
 * CD must assume an IAM role with GitHub OIDC.
 * Long-lived AWS access keys are refused even if a workflow is edited later.
 */

const FORBIDDEN_WORKFLOW = [
  /aws-access-key-id/i,
  /aws-secret-access-key/i,
  /AWS_ACCESS_KEY_ID/,
  /AWS_SECRET_ACCESS_KEY/,
  /secrets\.AWS_/,
  /AKIA[0-9A-Z]{16}/,
];

export interface ProtectionRule {
  type?: string;
  prevent_self_review?: boolean;
  reviewers?: readonly unknown[];
}

export function findAwsAccessKeyUsage(source: string): string[] {
  const hits: string[] = [];
  for (const pattern of FORBIDDEN_WORKFLOW) {
    if (pattern.test(source)) hits.push(pattern.source);
  }
  return hits;
}

export function assertCdWorkflow(source: string): void {
  const forbidden = findAwsAccessKeyUsage(source);
  if (forbidden.length > 0) {
    throw new Error(`CD workflow references AWS access keys (${forbidden.join(', ')})`);
  }
  const required = [
    'role-to-assume:',
    'id-token: write',
    'actions/attest-build-provenance@',
    'actions/attest-sbom@',
    'gh attestation verify',
    'name: staging',
    'name: production',
    'subject-digest:',
    'branches: [main]',
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(`CD workflow is missing: ${missing.join(', ')}`);
  }
  if (/\npull_request:/.test(source)) {
    throw new Error('CD workflow must not deploy from pull requests');
  }
}

export function assertOidcRoleArn(value: string | undefined): void {
  if (!value || !/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(value)) {
    throw new Error('AWS_CD_ROLE_ARN must be the GitHub OIDC IAM role ARN');
  }
}

export function assertEksClusterName(value: string | undefined): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) {
    throw new Error('EKS_CLUSTER_NAME must be the cluster name in ap-southeast-2');
  }
}

/**
 * `configure-aws-credentials` exports temporary ASIA keys after AssumeRoleWithWebIdentity.
 * AKIA keys are long-lived IAM user keys and must not reach a deploy job.
 */
export function assertTemporaryAwsCredentials(accessKeyId: string | undefined): void {
  if (!accessKeyId) {
    throw new Error('AWS credentials are missing; assume the CD role with OIDC');
  }
  if (!accessKeyId.startsWith('ASIA') || accessKeyId.length < 16) {
    throw new Error(
      'refusing long-lived AWS access keys; CD must use OIDC temporary credentials',
    );
  }
}

export function productionApprovalRequired(rules: readonly ProtectionRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.type === 'required_reviewers' &&
      rule.prevent_self_review === true &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.length > 0,
  );
}

export function assertOidcTemplate(source: string): void {
  if (source.includes('AWS::IAM::AccessKey') || /AKIA[0-9A-Z]{16}/.test(source)) {
    throw new Error('OIDC template must not create access keys');
  }
  const required = [
    'AssumeRoleWithWebIdentity',
    'token.actions.githubusercontent.com',
    'sts.amazonaws.com',
    'ecr:PutImage',
    'eks:DescribeCluster',
    'iam:CreateAccessKey',
    'ap-southeast-2',
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(`OIDC template is missing: ${missing.join(', ')}`);
  }
}

export function assertProductionEnvironment(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('production environment payload is missing');
  }
  const rules = (payload as { protection_rules?: unknown }).protection_rules;
  if (!Array.isArray(rules) || !productionApprovalRequired(rules as ProtectionRule[])) {
    throw new Error(
      'production environment must require a reviewer and prevent self-review before a deploy can start',
    );
  }
}
