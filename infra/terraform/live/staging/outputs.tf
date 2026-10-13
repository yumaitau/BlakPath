output "ses_configuration_set" {
  value = module.ses.configuration_set_name
}

output "ses_dkim_tokens" {
  value = module.ses.dkim_tokens
}

output "ses_mail_from_domain" {
  value = module.ses.mail_from_domain
}

output "certificate_validation_records" {
  value = module.edge.certificate_validation_records
}

output "web_acl_arn" {
  value = module.edge.web_acl_arn
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "external_secrets_role_arn" {
  value = module.pod_identity.external_secrets_role_arn
}

output "alb_controller_role_arn" {
  value = module.pod_identity.alb_controller_role_arn
}

output "database_url" {
  value     = module.data.database_url
  sensitive = true
}

output "redis_url" {
  value     = module.data.redis_url
  sensitive = true
}

output "repository_urls" {
  value = module.ecr.repository_urls
}
