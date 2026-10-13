# Pilot stack. Import the resources that already exist, then apply the drift
# fixes (rotation, bucket policy, lifecycle, access logs, ECR mutability and
# scanning, SES, backup, alarms, Pod Identity roles).
#
# VPC, RDS, Redis and the edge are in this configuration but off. They do not
# exist for the pilot. Turning them on is a create, reviewed in plan.
# ECR encryption stays AES256. See modules/ecr.

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

variable "enable_network" {
  type    = bool
  default = false
}

variable "enable_data_services" {
  type    = bool
  default = false
}

variable "enable_edge" {
  type    = bool
  default = false
}

variable "ses_webhook_endpoint" {
  type        = string
  default     = ""
  sensitive   = true
  description = "HTTPS URL including the webhook secret. Set with TF_VAR_ses_webhook_endpoint. Do not commit it."
}

variable "cluster_name" {
  type    = string
  default = null
}

variable "coa_signing_key_arn" {
  type    = string
  default = null
}

variable "alb_arn" {
  type    = string
  default = ""
}

locals {
  name = "blakpath-pilot"
  tags = {
    Application = "blakpath"
    Environment = "pilot"
    ManagedBy   = "terraform"
  }
  evidence_bucket   = "blakpath-prod-evidence-${var.account_id}-${var.region}"
  quarantine_bucket = "blakpath-prod-quarantine-${var.account_id}-${var.region}"
  log_bucket        = "blakpath-prod-access-logs-${var.account_id}-${var.region}"
}

resource "terraform_data" "guards" {
  lifecycle {
    precondition {
      condition     = !var.enable_data_services || var.enable_network
      error_message = "enable_data_services requires enable_network."
    }
  }
}

module "kms_app_secrets" {
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-app-secrets"
  account_id    = var.account_id
  manage_policy = false
  tags          = local.tags
}

module "kms_evidence" {
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-prod-evidence"
  account_id    = var.account_id
  manage_policy = false
  tags          = local.tags
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "/blakpath/production/runtime"
  description             = "BlakPath pilot runtime environment. Value is written by a human, never by Terraform."
  kms_key_id              = module.kms_app_secrets.key_arn
  recovery_window_in_days = 30
  tags                    = local.tags
}

module "storage" {
  source                 = "../../modules/storage"
  evidence_bucket_name   = local.evidence_bucket
  quarantine_bucket_name = local.quarantine_bucket
  log_bucket_name        = local.log_bucket
  kms_key_arn            = module.kms_evidence.key_arn
  kms_key_id             = module.kms_evidence.key_id
  account_id             = var.account_id
  tags                   = local.tags
}

module "ecr" {
  source          = "../../modules/ecr"
  name_prefix     = "blakpath"
  encryption_type = "AES256"
  tags            = local.tags
}

module "ses" {
  source           = "../../modules/ses"
  name             = local.name
  domain_name      = "blakpath.yumait.au"
  mail_from_domain = "mail.blakpath.yumait.au"
  webhook_endpoint = var.ses_webhook_endpoint
  tags             = local.tags
}

module "backup" {
  source        = "../../modules/backup"
  name          = local.name
  kms_key_arn   = module.kms_evidence.key_arn
  resource_arns = [module.storage.evidence_bucket_arn, module.storage.quarantine_bucket_arn]
  tags          = local.tags
}

module "observability" {
  source             = "../../modules/observability"
  name               = local.name
  log_group_name     = "/blakpath/pilot/application"
  metric_namespace   = "BlakPath/Operations"
  alarm_name_prefix  = "blakpath"
  log_retention_days = 365
  tags               = local.tags
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
  coa_signing_key_arn        = var.coa_signing_key_arn
  cluster_name               = var.cluster_name
  tags                       = local.tags
}

module "network" {
  count  = var.enable_network ? 1 : 0
  source = "../../modules/network"
  name   = local.name
  region = var.region
  tags   = local.tags
}

module "kms_data" {
  count         = var.enable_data_services ? 1 : 0
  source        = "../../modules/kms"
  alias_name    = "alias/blakpath-pilot-data"
  account_id    = var.account_id
  description   = "BlakPath pilot RDS and ElastiCache"
  manage_policy = true
  tags          = local.tags
}

module "data" {
  count                 = var.enable_data_services ? 1 : 0
  source                = "../../modules/data"
  name                  = local.name
  vpc_id                = module.network[0].vpc_id
  private_subnet_ids    = module.network[0].private_subnet_ids
  client_cidr_blocks    = module.network[0].private_subnet_cidrs
  kms_key_arn           = module.kms_data[0].key_arn
  backup_retention_days = 35
  multi_az              = true
  deletion_protection   = true
  tags                  = local.tags
}

module "edge" {
  count       = var.enable_edge ? 1 : 0
  source      = "../../modules/edge"
  name        = local.name
  domain_name = "blakpath.yumait.au"
  alb_arn     = var.alb_arn
  tags        = local.tags
}
