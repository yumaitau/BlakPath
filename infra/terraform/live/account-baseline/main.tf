# Account-region baseline. Separate from the pilot stack so a BlakPath plan
# does not move the default EBS key as a side effect of importing buckets.
# Apply this on its own, after reading the module comment.

variable "region" {
  type    = string
  default = "ap-southeast-2"
  validation {
    condition     = var.region == "ap-southeast-2"
    error_message = "BlakPath data stays in ap-southeast-2."
  }
}

variable "account_id" {
  type    = string
  default = "959038055523"
}

module "account_ebs" {
  source     = "../../modules/account_ebs"
  account_id = var.account_id
  tags = {
    Application = "account"
    Purpose     = "default-ebs"
    ManagedBy   = "terraform"
  }
}
