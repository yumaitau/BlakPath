# Fresh staging environment. No imports. One command: infra/terraform/staging-up.sh
# Uses its own names so it cannot adopt or destroy pilot buckets, keys or repos.

variable "region" {
  type    = string
  default = "ap-southeast-2"
  validation {
    condition     = var.region == "ap-southeast-2"
    error_message = "BlakPath data stays in ap-southeast-2."
  }
}

variable "account_id" {
  type    = string
  default = "959038055523"
}

variable "ses_webhook_endpoint" {
  type      = string
  default   = ""
  sensitive = true
}

variable "cluster_name" {
  type    = string
  default = null
}

variable "alb_arn" {
  type    = string
  default = ""
}

locals {
  name = "blakpath-staging"
  tags = {
    Application = "blakpath"
    Environment = "staging"
    ManagedBy   = "terraform"
  }
}

module "kms_app_secrets" {
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-staging-app-secrets"
  account_id    = var.account_id
  description   = "BlakPath staging Secrets Manager"
  manage_policy = true
  tags          = local.tags
}

module "kms_evidence" {
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-staging-evidence"
  account_id    = var.account_id
  description   = "BlakPath staging evidence buckets"
  manage_policy = true
  tags          = local.tags
}

module "kms_data" {
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-staging-data"
  account_id    = var.account_id
  description   = "BlakPath staging RDS and ElastiCache"
  manage_policy = true
  tags          = local.tags
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "/blakpath/staging/runtime"
  description             = "BlakPath staging runtime environment. Value is written by a human, never by Terraform."
  kms_key_id              = module.kms_app_secrets.key_arn
  recovery_window_in_days = 7
  tags                    = local.tags
}

module "storage" {
  source                 = "../../modules/storage"
  evidence_bucket_name   = "blakpath-staging-evidence-${var.account_id}-${var.region}"
  quarantine_bucket_name = "blakpath-staging-quarantine-${var.account_id}-${var.region}"
  log_bucket_name        = "blakpath-staging-access-logs-${var.account_id}-${var.region}"
  kms_key_arn            = module.kms_evidence.key_arn
  kms_key_id             = module.kms_evidence.key_id
  account_id             = var.account_id
  tags                   = local.tags
}

module "ecr" {
  source          = "../../modules/ecr"
  name_prefix     = "blakpath-staging"
  encryption_type = "KMS"
  kms_key_arn     = module.kms_app_secrets.key_arn
  tags            = local.tags
}

module "ses" {
  source           = "../../modules/ses"
  name             = local.name
  domain_name      = "staging.blakpath.yumait.au"
  mail_from_domain = "mail.staging.blakpath.yumait.au"
  webhook_endpoint = var.ses_webhook_endpoint
  tags             = local.tags
}

module "backup" {
  source            = "../../modules/backup"
  name              = local.name
  kms_key_arn       = module.kms_evidence.key_arn
  resource_arns     = [module.storage.evidence_bucket_arn, module.storage.quarantine_bucket_arn]
  delete_after_days = 14
  tags              = local.tags
}

module "observability" {
  source            = "../../modules/observability"
  name              = local.name
  log_group_name    = "/blakpath/staging/application"
  metric_namespace  = "BlakPath/Operations/staging"
  alarm_name_prefix = "blakpath-staging"
  tags              = local.tags
}

module "network" {
  source = "../../modules/network"
  name   = local.name
  region = var.region
  tags   = local.tags
}

module "data" {
  source                = "../../modules/data"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  client_cidr_blocks    = module.network.private_subnet_cidrs
  kms_key_arn           = module.kms_data.key_arn
  backup_retention_days = 7
  multi_az              = false
  deletion_protection   = false
  tags                  = local.tags
}

module "edge" {
  source      = "../../modules/edge"
  name        = local.name
  domain_name = "staging.blakpath.yumait.au"
  alb_arn     = var.alb_arn
  tags        = local.tags
}

module "pod_identity" {
  source                     = "../../modules/pod_identity"
  name                       = local.name
  account_id                 = var.account_id
  evidence_bucket_arn        = module.storage.evidence_bucket_arn
  quarantine_bucket_arn      = module.storage.quarantine_bucket_arn
  evidence_kms_key_arn       = module.kms_evidence.key_arn
  runtime_secret_arn         = aws_secretsmanager_secret.runtime.arn
  runtime_secret_kms_key_arn = module.kms_app_secrets.key_arn
  ses_identity_arn           = module.ses.identity_arn
  cluster_name               = var.cluster_name
  tags                       = local.tags
}
