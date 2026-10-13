# Move the account-wide default EBS key off alias/blakpath-app-secrets.
#
# New volumes encrypt with alias/account-ebs-default. Volumes already
# encrypted with the BlakPath key stay on that key. The BlakPath key is not
# deleted and its policy is not changed by this module. This is an
# account-region setting. Review the plan before apply; other applications
# create volumes against whatever the default is.

variable "account_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_iam_policy_document" "ebs" {
  statement {
    sid = "EnableIAMUserPermissions"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowEC2UseViaService"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:DescribeKey",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_kms_key" "ebs" {
  description             = "Account default EBS key. Not a BlakPath application key."
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.ebs.json
  tags                    = var.tags
}

resource "aws_kms_alias" "ebs" {
  name          = "alias/account-ebs-default"
  target_key_id = aws_kms_key.ebs.key_id
}

resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

resource "aws_ebs_default_kms_key" "this" {
  key_arn = aws_kms_key.ebs.arn
  depends_on = [
    aws_ebs_encryption_by_default.this,
    aws_kms_alias.ebs,
  ]
}

output "default_ebs_key_arn" {
  value = aws_kms_key.ebs.arn
}

output "default_ebs_key_alias" {
  value = aws_kms_alias.ebs.name
}
