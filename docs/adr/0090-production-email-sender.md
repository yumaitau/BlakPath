# ADR 0090: One production email sender — SES v2 API under the workload role

- **Status:** Accepted. Code, config and IaC example in this repository. The
  AWS and DNS set-up is an operator step (see
  [`docs/eks-runbook.md`](../eks-runbook.md#email)).
- **Date:** 2026-10-14
- **Relates to:** #90, #116 (production readiness), #42 (contracts and
  sub-processor register).

> **BlakPath never determines Aboriginality.** Email carries invitations,
> sign-in links and notifications. It never carries or makes a determination.

## Context

BlakPath is invite-only. Staff invitations, email verification and password
resets must reach people, or nobody can sign in. Before this decision the
repository described three senders:

- the code picked the SES API when `SMTP_USER` was unset and SES SMTP
  otherwise, so local development without `SMTP_USER` also tried SES;
- the runbook asked for `SMTP_USER`/`SMTP_PASSWORD`, which selects the SES SMTP
  interface with a long-lived credential;
- the ConfigMap, ExternalSecret, `.env.example` and runbook named PaperBoy
  (`paperboy.yumait.au`) as the production sender, but nothing read
  `PAPERBOY_URL` or `PAPERBOY_API_KEY`.

AWS state on 2026-10-13: SES has production access in ap-southeast-2 and the
parent `yumait.au` identity is DKIM-verified. There is no
`blakpath.yumait.au` identity, custom MAIL FROM, configuration set or event
destination.

## Options

| Option                          | Data location                                      | Credentials                                         | Bounces/complaints                            | Status                         |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| **SES v2 API** (chosen)         | AWS ap-southeast-2, our account (existing hosting) | Workload role (Pod Identity), no static secret      | Configuration set → SNS → `/api/email/events` | Code existed; config set added |
| SES SMTP interface              | Same                                               | Long-lived SMTP credential derived from an IAM user | Same                                          | Rejected                       |
| PaperBoy (`paperboy.yumait.au`) | Not documented; would be a new sub-processor       | Bearer API key in Secrets Manager                   | No documented contract                        | Placeholders only              |

## Decision

The SES v2 API in ap-southeast-2, called under the web and worker workload
roles, is the only production sender.

- `EMAIL_TRANSPORT=ses` selects it. `smtp` (the default) is the local and CI
  Mailpit catch-all. It is unauthenticated, and `sendEmail` refuses it when
  `NODE_ENV=production`.
- Every message carries `SES_CONFIGURATION_SET`. The set publishes `BOUNCE`
  and `COMPLAINT` events to SNS. A forwarder adds the
  `x-email-webhook-secret` header and posts to `POST /api/email/events`, which
  checks the SNS signature and the pinned `EMAIL_SNS_TOPIC_ARN`.
  Permanent bounces and complaints are suppressed as address hashes. Transient
  bounces are ignored so a full mailbox does not lock someone out.
- Mail is sent from a subdomain identity, `blakpath.yumait.au`, with Easy DKIM,
  custom MAIL FROM `bounce.blakpath.yumait.au` and its own DMARC record, so
  `dkim`, `spf` and `dmarc` all pass with alignment and BlakPath reputation is
  separate from other `yumait.au` mail.
- `SMTP_USER`, `SMTP_PASSWORD`, `PAPERBOY_URL` and `PAPERBOY_API_KEY` are
  removed from code, config and secrets. `pnpm release:check` fails if any is
  set, or if `EMAIL_TRANSPORT`, `SES_CONFIGURATION_SET`, a production
  `SMTP_FROM` or `EMAIL_WEBHOOK_SECRET` is missing.

## Why not PaperBoy

PaperBoy may be the right sender later, but it was not ready to accept
production records:

- Its data location and retention are not documented. It would be a new
  sub-processor and would need an entry in the sub-processor register (#42)
  before carrying invitation or reset links for client organisations.
- There is no documented contract for timeouts, idempotency keys or
  bounce/complaint callbacks. Without these, invitations could silently fail
  and bounced addresses would never be suppressed.
- SES already has production access in the same region and account as the
  rest of BlakPath, and needs no new secret.

To switch later: write a new ADR, add the PaperBoy register entry, implement a
transport with a request timeout, retry and an idempotency key equal to the
queue job id, wire its bounce/complaint events into suppressions, and change
the release gate. There must still be exactly one production sender.

## Consequences

- No mail credential exists to leak or rotate. SES access is granted by an IAM
  policy scoped to the identity and configuration set
  ([`infra/aws/ses-sending.example.yaml`](../../infra/aws/ses-sending.example.yaml)).
- The SES client uses a 3 s connect timeout, a 10 s request timeout and 3
  attempts, so a slow SES cannot hang a sign-in request. Tenant mail goes
  through the BullMQ Email queue, which retries with backoff.
- SES has no idempotency key. If a worker job fails after SES accepted the
  message, the retry can send a duplicate. A duplicate invitation or
  notification is acceptable. A lost one is not.
- SNS cannot send custom headers and the app rejects a secret in the query
  string, so a forwarder in front of the route adds `x-email-webhook-secret`.
  Rotate `EMAIL_WEBHOOK_SECRET` in the app and the forwarder together.
- Self-hosted deployments outside AWS need SES API access or a new ADR. There
  is no generic SMTP relay path in production.
