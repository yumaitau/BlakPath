#!/usr/bin/env bash
# Build a fresh staging environment. Prompts before apply. Does not touch pilot.
# State stays local unless you init again with infra/terraform/backend.hcl.example.
set -euo pipefail
cd "$(dirname "$0")/live/staging"
terraform init -input=false -backend=false
terraform apply -input=false "$@"
