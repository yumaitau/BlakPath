/**
 * Print the IaC parameters for one BlakPath-managed tenant CMK.
 * Does not call AWS. A human applies infra/aws/tenant-cmk in ap-southeast-2,
 * then an org admin registers the resulting key ARN.
 */
const organisationId = flag('--organisation-id');
const tenantSlug = flag('--slug');

if (!organisationId || !/^[0-9a-fA-F-]{36}$/.test(organisationId)) {
  fail('Pass --organisation-id as a UUID.');
}
if (!tenantSlug || !/^[a-z0-9-]{1,40}$/.test(tenantSlug)) {
  fail('Pass --slug as a lowercase DNS label, at most 40 characters.');
}

console.info('BlakPath-managed tenant CMK. This command does not call AWS.');
console.info('Template: infra/aws/tenant-cmk/cloudformation.yaml');
console.info('Terraform: infra/aws/tenant-cmk/main.tf');
console.info('Region: ap-southeast-2');
console.info(`OrganisationId=${organisationId}`);
console.info(`TenantSlug=${tenantSlug}`);
console.info('WorkloadRoleArns=<web task role ARN>,<worker task role ARN>');
console.info('After apply, register KeyArn with POST /api/organisation-keys.');

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
