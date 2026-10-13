# Log group, metric filters and alarms for the signals in
# infra/aws/operational-alerts.example.yaml.
#
# Pilot uses the namespace and metric names from that template. Staging uses
# its own namespace so the two environments do not add into the same metric.

variable "name" {
  type = string
}

variable "log_group_name" {
  type = string
}

variable "metric_namespace" {
  type = string
}

variable "alarm_name_prefix" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  signals = {
    exhausted = {
      alarm       = "${var.alarm_name_prefix}-queue-job-exhausted"
      description = "A BullMQ job exhausted its retry policy; follow the queue-failure runbook."
      filter_name = "queue_job_exhausted"
      pattern     = "{ $.signal = \"queue_job_exhausted\" && $.alert = true }"
      metric      = "QueueJobsExhausted"
      period      = 60
      evaluation  = 1
      threshold   = 1
      ok_actions  = true
    }
    audit = {
      alarm       = "${var.alarm_name_prefix}-audit-integrity-failure"
      description = "Audit hash-chain divergence detected; preserve data and escalate immediately."
      filter_name = "audit_integrity_failure"
      pattern     = "{ $.signal = \"audit_integrity_failure\" && $.alert = true }"
      metric      = "AuditIntegrityFailures"
      period      = 60
      evaluation  = 1
      threshold   = 1
      ok_actions  = false
    }
    scanner = {
      alarm       = "${var.alarm_name_prefix}-scanner-unavailable"
      description = "ClamAV is unavailable; evidence remains quarantined until service recovers."
      filter_name = "clamav_unavailable"
      pattern     = "{ $.signal = \"clamav_unavailable\" && $.alert = true }"
      metric      = "ScannerUnavailable"
      period      = 300
      evaluation  = 2
      threshold   = 2
      ok_actions  = true
    }
    readiness = {
      alarm       = "${var.alarm_name_prefix}-readiness-dependency-down"
      description = "A core dependency is preventing the web service from serving traffic."
      filter_name = "readiness_dependency_down"
      pattern     = "{ $.signal = \"readiness_dependency_down\" && $.alert = true }"
      metric      = "ReadinessDependencyFailures"
      period      = 60
      evaluation  = 3
      threshold   = 3
      ok_actions  = true
    }
  }
}

resource "aws_sns_topic" "oncall" {
  name = "${var.name}-oncall"
  tags = var.tags
}

resource "aws_cloudwatch_log_group" "application" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "signal" {
  for_each       = local.signals
  name           = "${var.name}-${each.value.filter_name}"
  log_group_name = aws_cloudwatch_log_group.application.name
  pattern        = each.value.pattern

  metric_transformation {
    name          = each.value.metric
    namespace     = var.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "signal" {
  for_each            = local.signals
  alarm_name          = each.value.alarm
  alarm_description   = each.value.description
  namespace           = var.metric_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = each.value.evaluation
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.oncall.arn]
  ok_actions          = each.value.ok_actions ? [aws_sns_topic.oncall.arn] : []
  tags                = var.tags

  depends_on = [aws_cloudwatch_log_metric_filter.signal]
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.application.name
}

output "oncall_topic_arn" {
  value = aws_sns_topic.oncall.arn
}
