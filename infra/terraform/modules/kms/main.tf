# Customer-managed key plus alias.
#
# Imported keys leave `manage_policy` false so Terraform does not replace a
# live key policy. `alias/blakpath-app-secrets` is the account default EBS key;
# rewriting that policy would break other applications. Rotation is still set.
# New keys (staging) set an account-root policy and let IAM grant use.

variable "alias_name" {
  type        = string
  description = "Full alias, including the alias/ prefix."
}

variable "account_id" {
  type = string
}

variable "description" {
  type    = string
  default = null
}

variable "manage_policy" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_iam_policy_document" "this" {
  count = var.manage_policy ? 1 : 0

  statement {
    sid = "EnableIAMUserPermissions"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "this" {
  description             = var.description
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = var.manage_policy ? data.aws_iam_policy_document.this[0].json : null

  lifecycle {
    # Tags on imported keys belong to whoever created them. Do not strip them.
    ignore_changes = [tags]
  }

  tags = var.tags
}

resource "aws_kms_alias" "this" {
  name          = var.alias_name
  target_key_id = aws_kms_key.this.key_id
}

output "key_id" {
  value = aws_kms_key.this.key_id
}

output "key_arn" {
  value = aws_kms_key.this.arn
}

output "alias_name" {
  value = aws_kms_alias.this.name
}
