# Domain identity, custom MAIL FROM, configuration set, SNS event destination.
#
# DNS (DKIM CNAMEs, MAIL FROM MX and SPF) is printed as output. This account's
# DNS is not in Route 53, so Terraform does not publish records.
# The webhook URL is optional. Leave it empty until a human supplies
# EMAIL_WEBHOOK_SECRET out of band. Do not commit that secret.

variable "name" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "mail_from_domain" {
  type = string
}

variable "webhook_endpoint" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_sns_topic" "events" {
  name = "${var.name}-ses-events"
  tags = var.tags
}

data "aws_iam_policy_document" "events" {
  statement {
    sid    = "AllowSesPublish"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events.json
}

resource "aws_sns_topic_subscription" "webhook" {
  count     = var.webhook_endpoint == "" ? 0 : 1
  topic_arn = aws_sns_topic.events.arn
  protocol  = "https"
  endpoint  = var.webhook_endpoint
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = "${var.name}-transactional"
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "bounces-and-complaints"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain_name
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = var.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

output "configuration_set_name" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "identity_arn" {
  value = aws_sesv2_email_identity.domain.arn
}

output "events_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "dkim_tokens" {
  value = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

output "mail_from_domain" {
  value = var.mail_from_domain
}
