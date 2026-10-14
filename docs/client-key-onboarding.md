# Client key onboarding

BlakPath encrypts a tenant's fields under a key the client can turn off.
The software still does not determine Aboriginality. A key only locks or
unlocks records. It does not score, rank or decide an application.

Deploy in **ap-southeast-2**. Two custody modes share one handshake.

## Client-owned CMK (BYOK)

The client applies either template in **their** account:

- `infra/client-kms/cloudformation.yaml`
- `infra/client-kms/main.tf`

Parameters are the organisation id, the BlakPath web and worker role ARNs,
and the BlakPath account id. Optional `AlertEmail` sends SNS mail when
someone calls `DisableKey`, `ScheduleKeyDeletion`, `EnableKey` or
`CancelKeyDeletion`. That rule reads CloudTrail management events, so the
account needs a trail that logs management events.

The key is a symmetric CMK with rotation on. The workload role may call
only `kms:GenerateDataKey`, `kms:Decrypt`, `kms:Encrypt` and
`kms:DescribeKey`.

- Crypto calls must send `kms:EncryptionContext:org_id` equal to that
  organisation, and `aws:SourceAccount` must be the BlakPath account.
- `kms:DescribeKey` is separate. It carries no encryption context. Binding
  it to `org_id` would hide key state from the health check.
- `kms:ViaService` is not set. BlakPath calls KMS itself. A ViaService
  condition would reject the handshake. It would apply only if some other
  AWS service called KMS on the client's behalf. This design does not.

### CloudTrail

KMS management events show key-policy and state changes. Data events show
each `GenerateDataKey` and `Decrypt`. Add the selector in
`infra/client-kms/cloudtrail-kms-data-events.json` to the client's trail,
replacing `REPLACE_WITH_KEY_ARN`. Data events are billed per call. The
health check adds one decrypt per tenant per interval, on top of real
envelope use.

## Registering the key

An organisation admin signs in again (step-up, five minutes) and calls:

`POST /api/organisation-keys`

```json
{
  "kmsKeyArn": "arn:aws:kms:ap-southeast-2:111122223333:key/...",
  "custodyMode": "client_owned"
}
```

`custodyMode` is `client_owned`, `client_owned_escrow` or
`blakpath_managed`. The organisation id comes from the session, not the
body.

The handshake:

1. `GenerateDataKey` and `Decrypt` with `{org_id: <this org>, purpose: key_validation}`. The plaintext must match.
2. `Decrypt` of that blob with org id `blakpath-handshake-negative` must fail.
3. `GenerateDataKey` with that same foreign org id must fail. If it
   succeeds, the key policy does not bind `org_id`, and validation fails.

A pass stores the wrapped data key as a canary and sets
`validation_status` to `passed` and `status` to `active`. A failure leaves
`status` at `pending_validation`. The canary plaintext is not stored.

`GET /api/organisation-keys` returns the ARN and status. It does not return
the canary.

## Activation

`POST /api/organisation/activation` (same step-up, `tenant:configure`)
sets the organisation to `active` only when the key is `active` and
validation has `passed`. Anything else returns 409. Records stay locked
while status is not `active`.

Non-production seed and the one-time pilot bootstrap still insert an
`active` organisation directly. They are not the production path.

## Health

Every `KEY_HEALTH_INTERVAL_MS` (default five minutes) the worker, for each
active organisation, calls `DescribeKey` and decrypts the canary with the
original context. A disabled key, a key pending deletion, or a decrypt
refusal updates `organisation_keys`, writes a platform audit event when
the usable status changes, notifies organisation admins, and logs
`signal=key_health_state_change`. Set `OPERATOR_ONCALL_EMAIL` so the
worker also emails on-call. The log signal pages the topic in
`infra/aws/operational-alerts.example.yaml` once that template is applied.

The first healthy observation after a deploy does not page. A later change
does, including recovery.

## BlakPath-managed key

`npx tsx scripts/tenant-cmk.ts --organisation-id <uuid> --slug <slug>`
prints parameters for `infra/aws/tenant-cmk`. It does not call AWS. A
human applies the template in the BlakPath account, then the org admin
registers the output ARN with `custodyMode` `blakpath_managed`. The key
policy matches the client template, with this account as both owner and
`aws:SourceAccount`.

Account-wide infrastructure (#62) is separate. This module is only the
per-tenant CMK.

## HYOK (external key store)

HYOK uses an AWS KMS external key store (XKS). Key material stays in the
client's HSM. KMS in ap-southeast-2 calls the client's XKS proxy, and the
proxy calls the HSM. BlakPath still sees a normal CMK ARN. The handshake,
the encryption context and the health check do not change.

What the client runs:

- An HSM they operate (CloudHSM in their account, or a key manager outside
  AWS).
- The AWS XKS proxy, reachable from KMS in ap-southeast-2, with the mTLS
  trust KMS requires.
- A KMS external key store and a key whose origin is that store.
- The same key policy as the BYOK template, including the `org_id`
  condition. XKS does not add a second policy language.

Latency and availability:

- Every uncached `GenerateDataKey` or `Decrypt` waits on the proxy and the
  HSM. Expect tens to a few hundred milliseconds of extra delay on a proxy
  in Sydney, more if the HSM is further away. Field decrypts reuse a
  process-local data key for at most five minutes, so the hop is not paid
  on every read.
- If the proxy or the HSM is down, KMS returns `KMSInvalidStateException`
  or the call times out. BlakPath fails closed: the key is marked
  unavailable, records lock (423 or 503), and the health job alerts admins
  and on-call. There is no plaintext fallback.
- Tenant encryption is therefore only as available as the client's proxy
  and HSM. That dependency is the point of HYOK and cannot be removed by
  BlakPath.
- Automatic annual rotation applies to AWS-generated symmetric key
  material. An external key store key does not rotate that way. The client
  rotates inside the HSM, or registers a new ARN and runs the handshake
  again. Old ciphertext stays wrapped by the previous key id until a later
  re-wrap.

The live call against a test XKS proxy is deferred. See
`docs/adr/0121-client-held-keys.md`.
