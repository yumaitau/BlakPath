# Evidence and quarantine buckets, plus an access-log bucket.
#
# Drift this module closes: TLS and the CMK are enforced, quarantine has a
# lifecycle, noncurrent versions expire, and server access logs are written.
# Current evidence objects are not expired. Abandoned quarantine objects are.

variable "evidence_bucket_name" {
  type = string
}

variable "quarantine_bucket_name" {
  type = string
}

variable "log_bucket_name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "kms_key_id" {
  type = string
}

variable "account_id" {
  type = string
}

variable "quarantine_expiration_days" {
  type    = number
  default = 90
}

variable "noncurrent_expiration_days" {
  type    = number
  default = 90
}

variable "log_expiration_days" {
  type    = number
  default = 365
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  data_buckets = {
    evidence = {
      name           = var.evidence_bucket_name
      expire_current = false
    }
    quarantine = {
      name           = var.quarantine_bucket_name
      expire_current = true
    }
  }
}

resource "aws_s3_bucket" "data" {
  for_each = local.data_buckets
  bucket   = each.value.name
  tags     = var.tags
}

resource "aws_s3_bucket" "logs" {
  bucket = var.log_bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "data" {
  for_each                = aws_s3_bucket.data
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

# Access logs use SSE-S3. Log delivery cannot assume a CMK grant.
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  for_each = local.data_buckets
  bucket   = aws_s3_bucket.data[each.key].id

  rule {
    id     = "noncurrent-and-multipart"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    dynamic "expiration" {
      for_each = each.value.expire_current ? [1] : []
      content {
        days = var.quarantine_expiration_days
      }
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_expiration_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_logging" "data" {
  for_each      = aws_s3_bucket.data
  bucket        = each.value.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "${each.key}/"
}

data "aws_iam_policy_document" "data" {
  for_each = aws_s3_bucket.data

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Header absent: bucket default encryption applies the CMK.
  # Header present and not aws:kms, or a different key: deny.
  statement {
    sid    = "DenyNonKmsEncryption"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${each.value.arn}/*"]
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyWrongKmsKey"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${each.value.arn}/*"]
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.kms_key_arn, var.kms_key_id]
    }
  }
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "S3ServerAccessLogs"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [for bucket in aws_s3_bucket.data : bucket.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.data[each.key].json
  depends_on = [
    aws_s3_bucket_public_access_block.data,
  ]
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json
  depends_on = [
    aws_s3_bucket_public_access_block.logs,
  ]
}

output "evidence_bucket_arn" {
  value = aws_s3_bucket.data["evidence"].arn
}

output "quarantine_bucket_arn" {
  value = aws_s3_bucket.data["quarantine"].arn
}

output "evidence_bucket_name" {
  value = aws_s3_bucket.data["evidence"].id
}

output "quarantine_bucket_name" {
  value = aws_s3_bucket.data["quarantine"].id
}

output "log_bucket_arn" {
  value = aws_s3_bucket.logs.arn
}

output "log_bucket_name" {
  value = aws_s3_bucket.logs.id
}
