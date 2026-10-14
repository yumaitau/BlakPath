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
  type        = string
  description = "BlakPath organisation id. Becomes kms:EncryptionContext:org_id."
}

variable "workload_role_arns" {
  type        = list(string)
  description = "Web and worker role ARNs in the BlakPath account."
}

variable "blakpath_account_id" {
  type        = string
  description = "Account that runs BlakPath. Checked as aws:SourceAccount."
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Optional address for key state alerts. Empty disables the topic."
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "client" {
  description              = "BlakPath envelope key for ${var.organisation_id}"
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
            "aws:SourceAccount"            = var.blakpath_account_id
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
            "aws:SourceAccount" = var.blakpath_account_id
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "client" {
  name          = "alias/blakpath-${var.organisation_id}"
  target_key_id = aws_kms_key.client.key_id
}

resource "aws_sns_topic" "key_state" {
  count = var.alert_email == "" ? 0 : 1
  name  = "blakpath-key-${var.organisation_id}"
}

resource "aws_sns_topic_subscription" "key_state" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.key_state[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_policy" "key_state" {
  count = var.alert_email == "" ? 0 : 1
  arn   = aws_sns_topic.key_state[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEventBridge"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.key_state[0].arn
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "key_state" {
  count       = var.alert_email == "" ? 0 : 1
  description = "Notify when a KMS key is disabled or scheduled for deletion."
  event_pattern = jsonencode({
    source      = ["aws.kms"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["kms.amazonaws.com"]
      eventName   = ["DisableKey", "ScheduleKeyDeletion", "EnableKey", "CancelKeyDeletion"]
    }
  })
}

resource "aws_cloudwatch_event_target" "key_state" {
  count      = var.alert_email == "" ? 0 : 1
  rule       = aws_cloudwatch_event_rule.key_state[0].name
  arn        = aws_sns_topic.key_state[0].arn
  depends_on = [aws_sns_topic_policy.key_state]
}

output "key_arn" {
  value = aws_kms_key.client.arn
}
