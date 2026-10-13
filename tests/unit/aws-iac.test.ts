import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('AWS infrastructure controls', () => {
  const kms = read('infra/terraform/modules/kms/main.tf');
  const storage = read('infra/terraform/modules/storage/main.tf');
  const ecr = read('infra/terraform/modules/ecr/main.tf');
  const ses = read('infra/terraform/modules/ses/main.tf');
  const ebs = read('infra/terraform/modules/account_ebs/main.tf');
  const pilot = read('infra/terraform/live/pilot/main.tf');
  const staging = read('infra/terraform/live/staging/main.tf');
  const verify = read('infra/terraform/scripts/verify-drift.sh');
  const stagingUp = read('infra/terraform/staging-up.sh');
  const workflow = read('.github/workflows/infra.yml');

  it('turns rotation on and does not retarget the account EBS default at a BlakPath key', () => {
    expect(kms).toMatch(/enable_key_rotation\s+=\s+true/);
    expect(ebs).toContain('alias/account-ebs-default');
    expect(ebs).toMatch(/enable_key_rotation\s+=\s+true/);
    expect(ebs).not.toMatch(/name\s+=\s+"alias\/blakpath-app-secrets"/);
    expect(pilot).toContain('manage_policy = false');
  });

  it('enforces TLS, the CMK, lifecycle and access logs on object storage', () => {
    expect(storage).toContain('sid    = "DenyInsecureTransport"');
    expect(storage).toContain('sid    = "DenyWrongKmsKey"');
    expect(storage).toContain('noncurrent_version_expiration');
    expect(storage).toContain('expire_current');
    expect(storage).toContain('aws_s3_bucket_logging');
  });

  it('makes new images immutable and scanned, and keeps pilot encryption in place', () => {
    expect(ecr).toContain('image_tag_mutability = "IMMUTABLE"');
    expect(ecr).toContain('scan_on_push = true');
    expect(ecr).toContain('aws_ecr_lifecycle_policy');
    expect(pilot).toContain('encryption_type = "AES256"');
    expect(staging).toContain('encryption_type = "KMS"');
  });

  it('defines the SES configuration set, MAIL FROM domain and SNS destination', () => {
    expect(ses).toContain('aws_sesv2_configuration_set');
    expect(ses).toContain('aws_sesv2_configuration_set_event_destination');
    expect(ses).toContain('mail_from_domain');
    expect(pilot).toContain('mail.blakpath.yumait.au');
    expect(staging).toContain('encryption_type = "KMS"');
  });

  it('builds staging from one command and plans in CI without mutating calls in the verifier', () => {
    expect(stagingUp).toContain('terraform apply');
    expect(stagingUp).toContain('live/staging');
    expect(workflow).toContain('terraform -chdir="infra/terraform/${stack}" validate');
    expect(workflow).toContain('terraform plan');
    expect(verify).toContain('get-key-rotation-status');
    expect(verify).toContain('get-bucket-policy');
    expect(verify).toContain('get-bucket-lifecycle-configuration');
    expect(verify).toContain('get-bucket-logging');
    expect(verify).toContain('describe-repositories');
    expect(verify).toContain('get-email-identity');
    expect(verify).toContain('get-ebs-default-kms-key-id');
    expect(verify).not.toMatch(/\b(put|delete|create|update)-/);
  });
});
