# Image repositories.
#
# Tag mutability, scan-on-push and the lifecycle policy update in place.
# encryption_configuration is ForceNew in the AWS provider: changing AES256 to
# KMS destroys the repository. Pilot keeps AES256 so apply cannot delete
# images. Staging and any new repository pass KMS. A pilot cutover is a new
# repository name plus an image copy, then a manifest change. It is not an
# in-place edit.

variable "name_prefix" {
  type        = string
  description = "Repository prefix, for example blakpath or blakpath-staging. Repositories are <prefix>/app and <prefix>/worker."
}

variable "encryption_type" {
  type = string
  validation {
    condition     = contains(["AES256", "KMS"], var.encryption_type)
    error_message = "encryption_type must be AES256 or KMS."
  }
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  repositories = toset(["app", "worker"])
}

resource "aws_ecr_repository" "this" {
  for_each             = local.repositories
  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = var.encryption_type
    kms_key         = var.encryption_type == "KMS" ? var.kms_key_arn : null
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 30 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 30
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "repository_urls" {
  value = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

output "repository_arns" {
  value = { for name, repo in aws_ecr_repository.this : name => repo.arn }
}
