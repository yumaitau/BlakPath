output "evidence_kms_key_arn" {
  value = module.kms_evidence.key_arn
}

output "app_secrets_kms_key_arn" {
  value = module.kms_app_secrets.key_arn
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "ses_configuration_set" {
  value = module.ses.configuration_set_name
}

output "ses_dkim_tokens" {
  value = module.ses.dkim_tokens
}

output "ses_mail_from_domain" {
  value = module.ses.mail_from_domain
}

output "web_role_arn" {
  value = module.pod_identity.web_role_arn
}

output "worker_role_arn" {
  value = module.pod_identity.worker_role_arn
}

output "external_secrets_role_arn" {
  value = module.pod_identity.external_secrets_role_arn
}

output "alb_controller_role_arn" {
  value = module.pod_identity.alb_controller_role_arn
}

output "log_group_name" {
  value = module.observability.log_group_name
}

output "database_url" {
  value     = try(module.data[0].database_url, null)
  sensitive = true
}

output "redis_url" {
  value     = try(module.data[0].redis_url, null)
  sensitive = true
}
