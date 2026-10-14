# Branch protection for `main`

`main` is protected by the repository ruleset in
[`.github/rulesets/main.json`](../.github/rulesets/main.json). The file is the
source of truth. Apply a change with:

```sh
# First time
gh api -X POST repos/yumaitau/BlakPath/rulesets --input .github/rulesets/main.json
# Later changes (id from `gh api repos/yumaitau/BlakPath/rulesets`)
gh api -X PUT repos/yumaitau/BlakPath/rulesets/<id> --input .github/rulesets/main.json
```

## What it enforces

- Changes land only through a pull request and the merge queue. Direct pushes,
  force-pushes and branch deletion are refused. Nobody bypasses it, admins
  included.
- Every required check must pass on the queued merge group, not just on the
  pull request. The queue tests each pull request on top of `main` plus the
  entries ahead of it. Two pull requests that pass alone but break together
  do not both land.
- Squash merges only, so history stays linear.

Required checks: typecheck/lint/format, unit and integration tests, production
build, browser and accessibility acceptance, Kubernetes manifest validation,
dependency scan, secret scan, container scan and SBOM, Trivy repository scan
and Node base image scan. CodeRabbit is advisory and not required.

All three workflows (`ci.yml`, `security.yml`, `trivy.yml`) run on
`merge_group`. A new required check must run on `pull_request` and
`merge_group`, or the queue waits for it until it times out.

## Reviews

The repository has one maintainer, so the ruleset requires zero approvals.
[`CODEOWNERS`](../.github/CODEOWNERS) marks the security-sensitive paths.
When a second maintainer joins, set `required_approving_review_count` to 1 and
`require_code_owner_review` to true, then re-apply the ruleset.

## Merging

```sh
gh pr merge <number> --squash   # adds the pull request to the merge queue
```
