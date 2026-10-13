/* eslint-disable no-restricted-properties -- deploy preflight reads the runner environment. */
import {
  assertEksClusterName,
  assertOidcRoleArn,
  assertTemporaryAwsCredentials,
} from '@/lib/cd/protection';

assertOidcRoleArn(process.env.AWS_CD_ROLE_ARN);
assertEksClusterName(process.env.EKS_CLUSTER_NAME);
assertTemporaryAwsCredentials(process.env.AWS_ACCESS_KEY_ID);
process.stdout.write('oidc credentials accepted\n');
