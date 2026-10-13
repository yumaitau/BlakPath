terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Partial backend. CI validate uses -backend=false.
  # Copy infra/terraform/backend.hcl.example and pass -backend-config.
  backend "s3" {}
}

provider "aws" {
  region = var.region
}
