# Continuous delivery

Pushes to `main` run `.github/workflows/cd.yml`. The workflow builds the web
and worker images, pushes them to ECR in `ap-southeast-2`, and attests SLSA
provenance plus an SPDX SBOM. Staging then production deploy that same digest.
Nothing in the workflow reads an AWS access key. GitHub Actions assumes
`blakpath-github-cd` with OIDC.

Deploys use `repository@sha256:<64 hex>`. The `run-<id>` tag on ECR is only an
alias for that push. Kubernetes is updated with `kubectl set image`, not by
moving a mutable tag.

## Order

1. **Release gate.** A Job runs `pnpm release:check` in the worker image, with
   the namespace ConfigMap and `blakpath-runtime` Secret. The web image is a
   standalone Next server and does not contain the checker. The worker image is
   built from the same commit and is the gate. The check fails closed on static
   S3 credentials.
2. **Migrate.** A Job runs `pnpm exec tsx src/db/migrate.ts` from that same
   worker digest. Migrations are forward-only. A failed migration does not
   change the Deployments.
3. **Rollout.** `blakpath-app` and `blakpath-worker` move to the new digests.
   ClamAV is left alone.
4. **Smoke.** `GET /api/ready` must report ready. `POST /api/auth/sign-in/email`
   must accept the smoke account: either a session cookie or a second-factor
   challenge. The probe does not open a tenant, record a decision, or infer
   identity.
5. **Rollback.** If the rollout or the smoke fails, both Deployments return to
   the images recorded beforehand. The database is not migrated down. Write
   migrations so the previous image can still run.

Before either Job, the script checks that the namespace `APP_URL` matches the
deploy target and that External Secrets reads `/blakpath/staging/runtime` or
`/blakpath/production/runtime`. A staging namespace pointed at the production
secret does not migrate.

## Production record

After production smoke passes, the workflow creates an annotated tag
`vMAJOR.MINOR.PATCH` on the commit that was built and publishes a GitHub
Release. The notes and `release-record.json` contain that tag, the commit, and
both digests. Verify the images with the `gh attestation verify` commands in
the Release.

The version is the next semver after the latest `v*` tag (or `package.json`
when no tag exists yet). The production checkout fetches tags so the next
release continues from that tag. `feat` is a minor bump, a breaking commit is major,
and every other unreleased commit is a patch, so each production deploy has its
own tag. The pipeline does not commit a version bump back to `main`: that
commit would not be the image that shipped.

Staging does not create a tag. It deploys the digest that production will ask
to approve.

## What a person has to do once

The workflow cannot turn these on by itself.

1. Apply `infra/aws/github-oidc-cd.example.yaml` in account `959038055523`,
   region `ap-southeast-2`. Pass `EksClusterName` when the cluster exists. If
   the account already has a GitHub OIDC provider, pass its ARN and leave
   `CreateOidcProvider` false. Set repository variable `AWS_CD_ROLE_ARN` to the
   stack output. Do not create an access key.
2. Set repository variable `EKS_CLUSTER_NAME`. The cluster auth mode must accept
   EKS access entries. The role is granted `AmazonEKSEditPolicy` on namespaces
   `blakpath` and `blakpath-staging` only. An administrator creates those
   namespaces; the role cannot. `AmazonEKSEditPolicy` also cannot read
   ExternalSecrets. `infra/k8s/base/cd-rbac.yaml` grants that role `get` on
   them. The first overlay apply creates the binding.
3. Create the GitHub environments before the first production run. Staging stays
   automatic. Production requires a reviewer and blocks self-approval:

   ```bash
   gh api --method PUT repos/yumaitau/BlakPath/environments/staging \
     --input - <<'JSON'
   {"wait_timer":0,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   JSON
   gh api --method POST \
     repos/yumaitau/BlakPath/environments/staging/deployment-branch-policies \
     -f name=main -f type=branch

   REVIEWER_ID="$(gh api users/LOGIN --jq .id)"
   gh api --method PUT repos/yumaitau/BlakPath/environments/production \
     --input - <<JSON
   {"wait_timer":0,"prevent_self_review":true,"reviewers":[{"type":"User","id":${REVIEWER_ID}}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   JSON
   gh api --method POST \
     repos/yumaitau/BlakPath/environments/production/deployment-branch-policies \
     -f name=main -f type=branch
   ```

   The production job also reads that environment and stops if the required
   reviewer rule or `prevent_self_review` is missing. Use a team reviewer id
   (`"type":"Team"`) instead of a user when a team should approve.

4. Allow GitHub Actions to push tags on `main`. The release step runs
   `git push origin refs/tags/vX.Y.Z` with no force. Branch protection that
   blocks the Actions bot from tags has to allow that push.
5. Create `/blakpath/staging/runtime` in Secrets Manager and a staging CMK.
   Replace `REPLACE_WITH_STAGING_CMK_ARN` in
   `infra/k8s/overlays/staging/configmap-patch.yaml`. Staging buckets in that
   patch must exist before evidence uploads work. Apply the overlay once:

   ```bash
   kubectl apply -k infra/k8s/overlays/staging
   kubectl apply -k infra/k8s/overlays/production
   ```

   The first apply still carries the image tags currently in the base
   manifests. After the Deployments exist, the pipeline only changes images.
   Re-applying the base later would move those tags back; don't.

6. Put `SMOKE_SIGN_IN_EMAIL` and `SMOKE_SIGN_IN_PASSWORD` on each GitHub
   environment. These are application credentials, not AWS keys. The account
   must be able to finish email/password sign-in or reach a second-factor
   challenge. Do not remove staff MFA to make the probe pass. Use an account
   that holds no authority to decide Confirmation of Aboriginality.
7. GitHub-hosted runners must be able to reach the public app URL. The ALB
   only allows Cloudflare ranges, so the hostname has to be proxied. Optional
   repository variables `STAGING_APP_URL` and `PRODUCTION_APP_URL` override
   `https://staging.blakpath.yumait.au` and `https://blakpath.yumait.au`.

ECR repositories `blakpath/app` and `blakpath/worker` are the ones already in
the manifests. The template does not create them.

## Local checks

`pnpm release:plan` prints the next tag from git history. It does not push.
