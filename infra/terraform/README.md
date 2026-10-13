# BlakPath AWS infrastructure

Terraform is the source of truth for BlakPath AWS resources in `ap-southeast-2`.
The CloudFormation files under `infra/aws/` remain the readable shape of the
workload policies and the operational signals. Do not deploy those examples.

Nothing in this tree is applied by CI. A human reviews `terraform plan` and applies it.

BlakPath does not score, rank or decide Aboriginality. These stacks only
provision infrastructure.

## Stacks

| Directory               | What it does                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live/pilot`            | Imports the hand-built pilot resources and encodes the drift fixes. Network, RDS, Redis and the edge stay off until a human sets the flags.      |
| `live/staging`          | A full environment with its own names. No imports.                                                                                               |
| `live/account-baseline` | New account default EBS key `alias/account-ebs-default`, with rotation. Separate so a pilot plan does not move that account setting by accident. |

Pilot resources that already exist: the two KMS keys and aliases, the runtime secret `/blakpath/production/runtime`, the evidence and quarantine buckets, and ECR `blakpath/app` and `blakpath/worker`. RDS, ElastiCache, backups, alarms, the SES identity and the access-log bucket do not exist yet. The first pilot plan creates those and updates the drift items. A second plan, after apply, should be empty.

## Drift this code fixes

- Rotation on `alias/blakpath-app-secrets` and `alias/blakpath-prod-evidence`. Key policies are not rewritten (`manage_policy = false`) because other applications use the app-secrets key.
- Evidence and quarantine bucket policies deny non-TLS and a non-CMK encryption header. Default encryption is the evidence CMK. Quarantine objects expire after 90 days. Noncurrent versions expire after 90 days. Server access logs go to a new log bucket.
- ECR tags are immutable, scan-on-push is on, and a lifecycle policy is set. Encryption on the **existing** repositories stays AES256. The AWS provider replaces a repository to change encryption, which would delete images. Staging repositories are created with KMS. A pilot cutover is a new repository, an image copy, and a manifest edit.
- SES domain `blakpath.yumait.au`, MAIL FROM `mail.blakpath.yumait.au`, configuration set `blakpath-pilot-transactional`, and an SNS destination for bounces and complaints.
- Account default EBS key moves to `alias/account-ebs-default` when the baseline stack is applied. Existing volumes stay on the BlakPath key.

## Fresh staging

```bash
./infra/terraform/staging-up.sh
```

The script inits with a local backend and runs `terraform apply` (it prompts). Staging uses `10.62.0.0/16`, its own keys, buckets and ECR repositories. It does not import or destroy pilot resources.

After apply:

1. Publish the SES DKIM and MAIL FROM records, and the ACM validation records, from the outputs. DNS is not in this account.
2. Copy the sensitive `database_url` and `redis_url` outputs into `/blakpath/staging/runtime`. Terraform does not write that secret's value.
3. Confirm S3 is opted in for AWS Backup in this region. The selection does not change the account-wide opt-in map.
4. When a cluster exists, re-apply with `-var cluster_name=...` to create Pod Identity associations. Install the AWS Load Balancer Controller and External Secrets with the role ARNs from the outputs. Apply `infra/k8s/cluster-secret-store.yaml` and `infra/k8s/external-secrets-serviceaccount.yaml`.

## Pilot plan

```bash
cd infra/terraform/live/pilot
terraform init -input=false -backend=false
terraform plan -input=false
```

Import blocks run as part of plan. Review every change. Do not apply a plan that replaces an ECR repository or schedules a KMS key for deletion.

Remote state, once a state bucket exists:

```bash
terraform init -backend-config=../../backend.hcl
```

`backend.hcl` is gitignored. Start from `backend.hcl.example`. Use a different `key` per stack (`pilot/terraform.tfstate`, `staging/terraform.tfstate`, `account-baseline/terraform.tfstate`).

Set `TF_VAR_ses_webhook_endpoint` to the HTTPS URL that includes `EMAIL_WEBHOOK_SECRET`. Do not commit it. Leave it empty and the SNS topic still exists; the HTTPS subscription is skipped.

## Verify

After apply, from a credential that can read the account:

```bash
./infra/terraform/scripts/verify-drift.sh
```

The script only calls Get and Describe APIs.

## CI

`.github/workflows/infra.yml` runs `terraform fmt -check` and `terraform validate` on every pull request. `terraform plan` runs only when the repository variables `BLAKPATH_AWS_PLAN_ROLE_ARN` and `BLAKPATH_TF_STATE_BUCKET` are set (GitHub OIDC). The plan job fails on errors. It fails on a non-empty diff only when `BLAKPATH_PLAN_MUST_BE_CLEAN` is `true`, which is the switch to use after the first apply.

## What a human still does

- Apply each stack. This repository does not run apply.
- Create the Terraform state bucket before remote init.
- Opt S3 (and RDS, once it exists) into AWS Backup for the region.
- Publish DNS for SES and ACM.
- Write runtime secret values.
- Decide when to apply `live/account-baseline`. New EBS volumes will use the new key.
- Plan a new ECR repository if pilot images must move from AES256 to a CMK.
- Install cluster add-ons once a cluster name exists. This stack does not create the EKS control plane.
- Point container logs at `/blakpath/pilot/application` so the metric filters see the signals.
