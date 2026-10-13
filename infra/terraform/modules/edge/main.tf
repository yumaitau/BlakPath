# Regional WAF web ACL and an ACM certificate.
#
# Certificate validation is not waited on. DNS for this domain is outside
# Route 53; a human publishes the validation records from the output.
# Associate the web ACL with the ALB after the ingress controller creates it
# (variable alb_arn). An empty alb_arn leaves the ACL unassociated.

variable "name" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "alb_arn" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  managed_rules = {
    AWSManagedRulesCommonRuleSet = {
      priority = 10
    }
    AWSManagedRulesKnownBadInputsRuleSet = {
      priority = 20
    }
    AWSManagedRulesAmazonIpReputationList = {
      priority = 30
    }
  }
}

resource "aws_wafv2_web_acl" "this" {
  name  = "${var.name}-alb"
  scope = "REGIONAL"
  tags  = var.tags

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.managed_rules
    content {
      name     = rule.key
      priority = rule.value.priority
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-${rule.key}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-alb"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  count        = var.alb_arn == "" ? 0 : 1
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}

output "certificate_arn" {
  value = aws_acm_certificate.this.arn
}

output "certificate_validation_records" {
  value = [
    for record in aws_acm_certificate.this.domain_validation_options : {
      name  = record.resource_record_name
      type  = record.resource_record_type
      value = record.resource_record_value
    }
  ]
}
