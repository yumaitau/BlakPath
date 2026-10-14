terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40.0"
    }
  }
}

provider "aws" {
  region = "ap-southeast-2"
}

variable "organisation_id" {
  type = string
}

variable "tenant_slug" {
  type = string
}

variable "workload_role_arns" {
  type = list(string)
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "tenant" {
  description              = "BlakPath managed key for ${var.tenant_slug}"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  deletion_window_in_days  = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "BlakPathEnvelope"
        Effect    = "Allow"
        Principal = { AWS = var.workload_role_arns }
        Action    = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:org_id" = var.organisation_id
            "aws:SourceAccount"            = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid       = "BlakPathDescribe"
        Effect    = "Allow"
        Principal = { AWS = var.workload_role_arns }
        Action    = "kms:DescribeKey"
        Resource  = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "tenant" {
  name          = "alias/blakpath-tenant-${var.tenant_slug}"
  target_key_id = aws_kms_key.tenant.key_id
}

output "key_arn" {
  value = aws_kms_key.tenant.arn
}
