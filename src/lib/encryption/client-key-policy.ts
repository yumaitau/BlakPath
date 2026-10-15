/**
 * Key policy a client (or the BlakPath-managed tenant stack) attaches to one
 * symmetric CMK. The workload role may wrap and unwrap only when the encryption
 * context names this organisation, and only when the call comes from the
 * BlakPath account.
 *
 * `kms:DescribeKey` is a separate statement. DescribeKey carries no encryption
 * context, so binding it to `kms:EncryptionContext:org_id` would hide key state
 * from the health check. `kms:ViaService` is not set: BlakPath calls KMS
 * directly. A ViaService condition would reject the handshake.
 */

export const CLIENT_KEY_CRYPTO_ACTIONS = [
  'kms:Decrypt',
  'kms:Encrypt',
  'kms:GenerateDataKey',
] as const;

export const CLIENT_KEY_DESCRIBE_ACTION = 'kms:DescribeKey';

export interface ClientKeyPolicyInput {
  readonly organisationId: string;
  readonly workloadRoleArns: readonly string[];
  readonly blakPathAccountId: string;
  /** Account root that retains key administration. Not the workload role. */
  readonly adminRootArn: string;
}

interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Principal: { readonly AWS: string | readonly string[] };
  readonly Action: string | readonly string[];
  readonly Resource: '*';
  readonly Condition?: {
    readonly StringEquals: Readonly<Record<string, string>>;
  };
}

export interface ClientKeyPolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly PolicyStatement[];
}

export function buildClientKeyPolicy(
  input: ClientKeyPolicyInput,
): ClientKeyPolicyDocument {
  const roles =
    input.workloadRoleArns.length === 1
      ? input.workloadRoleArns[0]!
      : input.workloadRoleArns;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AccountAdmin',
        Effect: 'Allow',
        Principal: { AWS: input.adminRootArn },
        Action: 'kms:*',
        Resource: '*',
      },
      {
        Sid: 'BlakPathEnvelope',
        Effect: 'Allow',
        Principal: { AWS: roles },
        Action: CLIENT_KEY_CRYPTO_ACTIONS,
        Resource: '*',
        Condition: {
          StringEquals: {
            'kms:EncryptionContext:org_id': input.organisationId,
            'aws:SourceAccount': input.blakPathAccountId,
          },
        },
      },
      {
        Sid: 'BlakPathDescribe',
        Effect: 'Allow',
        Principal: { AWS: roles },
        Action: CLIENT_KEY_DESCRIBE_ACTION,
        Resource: '*',
        Condition: {
          StringEquals: {
            'aws:SourceAccount': input.blakPathAccountId,
          },
        },
      },
    ],
  };
}
