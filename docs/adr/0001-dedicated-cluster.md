# ADR 0001 — Dedicated cluster for BlakPath

## Status

Accepted as the target. Cutover is an operator change, not an application
release.

## Context

BlakPath is one application on the shared EKS cluster `yumait-prod`. Runtime
configuration has to stay readable only from the `blakpath` namespace. The
shared cluster also publishes its Kubernetes API to the internet, places nodes
in public subnets, and uses a default-allow network policy. Database and cache
security groups admit the whole VPC.

Those are platform boundaries. The application cannot enforce them.

## Decision

Run BlakPath production workloads on a dedicated EKS cluster in the same AWS
account and in `ap-southeast-2`.

That cluster:

- keeps the Kubernetes API private and reaches it through Tailscale;
- places nodes in private subnets, without public node addresses;
- defaults the network policy to deny;
- limits database and cache security groups to BlakPath pod traffic;
- uses the namespace-scoped secret sync in `infra/aws/eks-boundary.example.yaml`.

A separate AWS account is not part of this cutover. Revisit a dedicated account
if a second operator needs its own IAM and billing boundary.

Until that cluster exists, BlakPath may stay on `yumait-prod` only when all of
the following are true:

- secret sync matches `infra/aws/eks-boundary.example.yaml`;
- there is no standing SES SMTP user and no `AmazonSESFullAccess` on BlakPath;
- the API endpoint is private, or its public CIDRs are named admin or CI
  networks, never `0.0.0.0/0` or `::/0`.

Changing the shared cluster's API endpoint affects every team on it. Prefer the
dedicated cluster for that change. If BlakPath remains on `yumait-prod`,
coordinate the endpoint change with those teams.

## Consequences

- Operators apply the boundary template, the workload trust policy, and the
  endpoint contract before production records. Steps are in
  `docs/eks-runbook.md`.
- The shared External Secrets role loses access to `/blakpath/production/*` and
  to the BlakPath app-secrets key. Other applications keep their own secrets.
- `/blakpath/production/runtime` is rotated after the scope change. Record the
  rotation without copying secret values.
- Node placement, security groups, and the default-allow network policy move
  with the dedicated cluster. They are not changed on `yumait-prod` by the
  application manifests.
