# Daily AWS Backup of the evidence and quarantine buckets.
#
# Account-level backup resource-type opt-in is not managed here. That setting
# is regional and shared with every other application. A human confirms S3 is
# opted in before the first backup job (see infra/terraform/README.md).

variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "resource_arns" {
  type = list(string)
}

variable "delete_after_days" {
  type    = number
  default = 35
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_backup_vault" "this" {
  name        = var.name
  kms_key_arn = var.kms_key_arn
  tags        = var.tags
}

resource "aws_backup_plan" "this" {
  name = "${var.name}-daily"
  tags = var.tags

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 16 * * ? *)"
    lifecycle {
      delete_after = var.delete_after_days
    }
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_iam_role_policy_attachment" "s3_backup" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup"
}

resource "aws_iam_role_policy_attachment" "s3_restore" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore"
}

resource "aws_backup_selection" "this" {
  name         = "${var.name}-resources"
  iam_role_arn = aws_iam_role.this.arn
  plan_id      = aws_backup_plan.this.id
  resources    = var.resource_arns
}

resource "aws_cloudwatch_metric_alarm" "failed_jobs" {
  alarm_name          = "${var.name}-backup-jobs-failed"
  alarm_description   = "AWS Backup reported a failed job for this vault. Stop any restore and keep the recovery point."
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfBackupJobsFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    BackupVaultName = aws_backup_vault.this.name
  }
  tags = var.tags
}

output "vault_name" {
  value = aws_backup_vault.this.name
}

output "vault_arn" {
  value = aws_backup_vault.this.arn
}

output "plan_arn" {
  value = aws_backup_plan.this.arn
}
