# Pod Identity roles. Web and worker have no Secrets Manager permission and no
# access keys. External Secrets reads only the named runtime secret. The
# platform ESO role is not modified.
#
# Associations and the pod-identity-agent addon are created only when
# cluster_name is set. The pilot has no BlakPath namespace yet.

variable "name" {
  type = string
}

variable "account_id" {
  type = string
}

variable "evidence_bucket_arn" {
  type = string
}

variable "quarantine_bucket_arn" {
  type = string
}

variable "evidence_kms_key_arn" {
  type = string
}

variable "runtime_secret_arn" {
  type = string
}

variable "runtime_secret_kms_key_arn" {
  type = string
}

variable "ses_identity_arn" {
  type    = string
  default = null
}

variable "coa_signing_key_arn" {
  type    = string
  default = null
}

variable "cluster_name" {
  type    = string
  default = null
}

variable "namespace" {
  type    = string
  default = "blakpath"
}

variable "manage_pod_identity_addon" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_iam_policy_document" "pods" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
    actions = ["sts:AssumeRole", "sts:TagSession"]
  }
}

resource "aws_iam_role" "web" {
  name               = "${var.name}-web"
  assume_role_policy = data.aws_iam_policy_document.pods.json
  tags               = var.tags
}

resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.pods.json
  tags               = var.tags
}

resource "aws_iam_role" "external_secrets" {
  name               = "${var.name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.pods.json
  tags               = var.tags
}

resource "aws_iam_role" "alb_controller" {
  name               = "${var.name}-alb-controller"
  assume_role_policy = data.aws_iam_policy_document.pods.json
  tags               = var.tags
}

data "aws_iam_policy_document" "web" {
  statement {
    sid       = "ListEvidence"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.evidence_bucket_arn]
  }
  statement {
    sid       = "QuarantineUploads"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${var.quarantine_bucket_arn}/*"]
  }
  statement {
    sid       = "CleanEvidenceDownloads"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.evidence_bucket_arn}/*"]
  }
  statement {
    sid       = "EvidenceKms"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.evidence_kms_key_arn]
  }
  dynamic "statement" {
    for_each = var.ses_identity_arn == null ? [] : [var.ses_identity_arn]
    content {
      sid       = "SendMail"
      effect    = "Allow"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [statement.value]
    }
  }
  dynamic "statement" {
    for_each = var.coa_signing_key_arn == null ? [] : [var.coa_signing_key_arn]
    content {
      sid       = "SignCertificates"
      effect    = "Allow"
      actions   = ["kms:Sign", "kms:Verify", "kms:GetPublicKey", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ListBuckets"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.evidence_bucket_arn, var.quarantine_bucket_arn]
  }
  statement {
    sid       = "QuarantineReadDelete"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.quarantine_bucket_arn}/*"]
  }
  statement {
    sid       = "EvidencePromote"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.evidence_bucket_arn}/*"]
  }
  statement {
    sid       = "EvidenceKms"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.evidence_kms_key_arn]
  }
  dynamic "statement" {
    for_each = var.ses_identity_arn == null ? [] : [var.ses_identity_arn]
    content {
      sid       = "SendMail"
      effect    = "Allow"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [statement.value]
    }
  }
}

data "aws_iam_policy_document" "external_secrets" {
  statement {
    sid       = "ReadRuntimeSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:ListSecretVersionIds"]
    resources = [var.runtime_secret_arn]
  }
  statement {
    sid       = "DecryptRuntimeSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.runtime_secret_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "web" {
  name   = "blakpath-web"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "blakpath-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy" "external_secrets" {
  name   = "blakpath-external-secrets"
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets.json
}

resource "aws_iam_role_policy" "alb_controller" {
  name   = "blakpath-alb-controller"
  role   = aws_iam_role.alb_controller.id
  policy = file("${path.module}/alb-controller-policy.json")
}

resource "aws_eks_pod_identity_association" "web" {
  count           = var.cluster_name == null ? 0 : 1
  cluster_name    = var.cluster_name
  namespace       = var.namespace
  service_account = "blakpath-web"
  role_arn        = aws_iam_role.web.arn
}

resource "aws_eks_pod_identity_association" "worker" {
  count           = var.cluster_name == null ? 0 : 1
  cluster_name    = var.cluster_name
  namespace       = var.namespace
  service_account = "blakpath-worker"
  role_arn        = aws_iam_role.worker.arn
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  count           = var.cluster_name == null ? 0 : 1
  cluster_name    = var.cluster_name
  namespace       = "external-secrets"
  service_account = "blakpath-external-secrets"
  role_arn        = aws_iam_role.external_secrets.arn
}

resource "aws_eks_pod_identity_association" "alb_controller" {
  count           = var.cluster_name == null ? 0 : 1
  cluster_name    = var.cluster_name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.alb_controller.arn
}

resource "aws_eks_addon" "pod_identity_agent" {
  count                       = var.cluster_name != null && var.manage_pod_identity_addon ? 1 : 0
  cluster_name                = var.cluster_name
  addon_name                  = "eks-pod-identity-agent"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = var.tags
}

output "web_role_arn" {
  value = aws_iam_role.web.arn
}

output "worker_role_arn" {
  value = aws_iam_role.worker.arn
}

output "external_secrets_role_arn" {
  value = aws_iam_role.external_secrets.arn
}

output "alb_controller_role_arn" {
  value = aws_iam_role.alb_controller.arn
}
