#!/usr/bin/env bash
# Read-only Describe/Get checks for the issue 62 drift items.
# Does not change the account. A human runs this after apply.
set -euo pipefail

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
ACCOUNT_ID="${ACCOUNT_ID:-959038055523}"
EVIDENCE="blakpath-prod-evidence-${ACCOUNT_ID}-${AWS_DEFAULT_REGION}"
QUARANTINE="blakpath-prod-quarantine-${ACCOUNT_ID}-${AWS_DEFAULT_REGION}"

echo "== KMS rotation (both KeyRotationEnabled must be true) =="
aws kms get-key-rotation-status --key-id alias/blakpath-app-secrets
aws kms get-key-rotation-status --key-id alias/blakpath-prod-evidence

echo "== Bucket policy, lifecycle, logging =="
aws s3api get-bucket-policy --bucket "$EVIDENCE"
aws s3api get-bucket-policy --bucket "$QUARANTINE"
aws s3api get-bucket-lifecycle-configuration --bucket "$EVIDENCE"
aws s3api get-bucket-lifecycle-configuration --bucket "$QUARANTINE"
aws s3api get-bucket-logging --bucket "$EVIDENCE"
aws s3api get-bucket-logging --bucket "$QUARANTINE"

echo "== ECR mutability, scan on push, lifecycle =="
aws ecr describe-repositories --repository-names blakpath/app blakpath/worker
aws ecr get-lifecycle-policy --repository-name blakpath/app
aws ecr get-lifecycle-policy --repository-name blakpath/worker

echo "== SES identity, MAIL FROM, configuration set, event destination =="
aws sesv2 get-email-identity --email-identity blakpath.yumait.au
aws sesv2 get-configuration-set --configuration-set-name blakpath-pilot-transactional
aws sesv2 get-configuration-set-event-destinations --configuration-set-name blakpath-pilot-transactional

echo "== Account default EBS key (alias must be alias/account-ebs-default) =="
aws ec2 get-ebs-encryption-by-default
aws ec2 get-ebs-default-kms-key-id
aws kms describe-key --key-id alias/account-ebs-default --query 'KeyMetadata.KeyId' --output text
