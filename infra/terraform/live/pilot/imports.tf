# Import ids are stable names. KMS accepts an alias as a key id.
# Sub-resources (bucket encryption, public access block, lifecycle) use Put
# APIs and are adopted on the first apply; they are not separate imports.
# The access-log bucket, SES identity, backup vault and alarms do not exist
# yet. The first plan creates them. A later plan is empty.

import {
  to = module.kms_app_secrets.aws_kms_key.this
  id = "alias/blakpath-app-secrets"
}

import {
  to = module.kms_app_secrets.aws_kms_alias.this
  id = "alias/blakpath-app-secrets"
}

import {
  to = module.kms_evidence.aws_kms_key.this
  id = "alias/blakpath-prod-evidence"
}

import {
  to = module.kms_evidence.aws_kms_alias.this
  id = "alias/blakpath-prod-evidence"
}

import {
  to = aws_secretsmanager_secret.runtime
  id = "/blakpath/production/runtime"
}

import {
  to = module.storage.aws_s3_bucket.data["evidence"]
  id = "blakpath-prod-evidence-959038055523-ap-southeast-2"
}

import {
  to = module.storage.aws_s3_bucket.data["quarantine"]
  id = "blakpath-prod-quarantine-959038055523-ap-southeast-2"
}

import {
  to = module.ecr.aws_ecr_repository.this["app"]
  id = "blakpath/app"
}

import {
  to = module.ecr.aws_ecr_repository.this["worker"]
  id = "blakpath/worker"
}
