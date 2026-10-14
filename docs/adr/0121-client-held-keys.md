# ADR 0121 — Client-held keys (BYOK and HYOK)

Date: 2026-10-14. Status: accepted for the application path. The live XKS
proxy test is deferred.

## Context

Issue #121 asks for a client-deployed CMK, a validation handshake, an
activation gate, a health monitor, a BlakPath-managed per-tenant CMK, and
an XKS (HYOK) path tested once against a proxy or explicitly deferred.

Issue #119 already stores one KMS ARN per organisation and fails closed
when that key is disabled or unreachable. This ADR covers onboarding and
health, not a second envelope format.

## Decision

- The client deploys `infra/client-kms` in their account, ap-southeast-2.
  The policy grants the workload role only `GenerateDataKey`, `Decrypt`,
  `Encrypt` and `DescribeKey`. Crypto calls require
  `kms:EncryptionContext:org_id` and `aws:SourceAccount`. DescribeKey does
  not, because it has no encryption context. `kms:ViaService` is omitted
  because the app calls KMS directly.
- Registration is `POST /api/organisation-keys` after step-up. The
  handshake is GenerateDataKey + Decrypt with the tenant context, then a
  negative decrypt and a negative GenerateDataKey under
  `org_id=blakpath-handshake-negative`. Only a pass sets the key `active`.
- `POST /api/organisation/activation` refuses to set the organisation
  `active` unless that key is active and validation has passed.
- A worker job every `KEY_HEALTH_INTERVAL_MS` (default 5 minutes) calls
  DescribeKey and decrypts the stored canary. A state change notifies
  organisation admins and emits `key_health_state_change` for on-call,
  plus email when `OPERATOR_ONCALL_EMAIL` is set.
- BlakPath-managed mode is `infra/aws/tenant-cmk`, printed by
  `scripts/tenant-cmk.ts`. The command does not call AWS.
- An XKS key is the same ARN shape. Failure and latency are documented in
  `docs/client-key-onboarding.md`. Availability of tenant encryption equals
  the client's proxy and HSM.

## XKS test deferred

A live test needs an external key store registered on a KMS endpoint in
ap-southeast-2 and an XKS proxy the service can reach. Registering that
store calls AWS APIs that change the account. This work must not apply
infrastructure. The XKS protocol runs between KMS and the proxy, not
between BlakPath and the proxy, so a local HTTP stand-in would not sit on
the path the app uses.

The app path is covered without that dependency: the handshake and the
health check take a CMK ARN, and KMS errors (`AccessDeniedException`,
`DisabledException`, `KMSInvalidStateException`) already fail closed. A
human can repeat the handshake against a test XKS key later by registering
its ARN. No application change is required for that run.

## Consequences

- The workload role template must allow purpose `key_validation` and, on
  the worker, `kms:DescribeKey`. A human applies that change.
- Client CloudTrail data events are the client's bill and the client's
  trail. The repo ships the selector, not a trail in their account.
- Non-production seed and pilot bootstrap still insert `active` without a
  key. Production activation does not.
