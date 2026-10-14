# Records disposal

BlakPath records how an organisation keeps and destroys its own records. It does not decide which statute applies, which disposal class number to cite, or whether a person is Aboriginal or Torres Strait Islander.

Destroying a public record outside an approved disposal authority can be an offence. Confirmation of Aboriginality records may have to be kept for a long time, or permanently. The controls below make that a recorded human decision.

## Catalogue

Every audit resource type maps to one disposal class (`src/domains/retention/disposal.ts`). The class says what kind of record it is. It does not set a keep period.

Three classes can never be destroyed by the sweep, whatever a sign-off says:

- `immutable_audit` — the tamper-evident audit trail
- `retention_control` — retention policies, authority sign-offs, and the destruction register
- `key_custody` — tenant key custody, rewraps and crypto-shred certificates

`GET /api/retention/disposal-classes` returns the catalogue, including the jurisdiction labels. Those labels name statutes a records manager may be working under. They are not a finding that the statute applies.

The worker currently destroys only `application`, `evidence`, and `form_response`. Other classes can be classified, marked permanent, or scheduled. They are not destroyed until a sweep for that class exists.

## Sign-off

A person with `retention:manage` signs one class in one jurisdiction:

`POST /api/retention/disposal-authorities` (requires step-up)

The body cites the authority reference (for example a GA39 item, a PROS class, a QSA reference, or the organisation's own schedule), whether the class is permanent, and any minimum keep period taken from that authority. The software does not invent those values.

A later sign-off for the same organisation, jurisdiction, and class supersedes the earlier one. Sign-offs are tied to the catalogue version. After the catalogue changes, an old sign-off no longer authorises a purge until someone signs the new catalogue.

## Policies

`POST /api/retention/policies` drafts an inactive policy.

- `retain` with no `retentionDays` is permanent. The sweep never treats those records as due.
- `purge` and `anonymise` need a finite period of at least 30 days. There is no 10-year cap. The only numeric ceiling is an input sanity bound (1,000 years), not a legal maximum.
- `purge` must include an `authorityReference` that matches a current sign-off for that resource's class and jurisdiction. The period cannot be shorter than the minimum on that sign-off. A sign-off marked permanent blocks a purge of that class.

`POST /api/retention/policies/{id}/activate` turns the draft on (requires step-up). The caller must hold `retention:manage` and must not be the person who drafted it. One person cannot activate their own policy.

## What the sweep checks

On every run, before it touches a record:

- The policy must be active and activated by someone other than its drafter.
- A `purge` policy must still match a current sign-off for its class and jurisdiction. If it does not, the sweep skips the policy and writes a `retention.purge_blocked` audit event with a coded reason such as `retention.purge_blocked.no_signoff`.
- Purge tombstones the row and removes every S3 object version. The hard delete after the 30-day grace runs only under a `purge` policy that still passes that check.
- A decided application, a finalised decision, or an issued certificate is an official record. Neither purge nor anonymise touches it, or its evidence and form responses, unless the policy's authority is verified as above. A reference string with no matching sign-off does not count.

## Destruction register

Each purge that commits writes a row: what was destroyed, when, the class, the jurisdiction, the authority reference, the policy, and the sweep correlation id. Anonymising a record does not write a row.

Purge is a tombstone plus removal of every S3 object version; the row is hard-deleted after a 30-day grace.

- `GET /api/retention/destruction-register` returns JSON.
- `GET /api/retention/destruction-register?format=csv` returns a CSV file.
- Report type `destruction_register` is also available through the existing export worker.

The download is audited.

## What a person still has to do

1. Counsel or the records manager confirms which jurisdiction and which disposal authority actually apply. The catalogue is a classification, not legal advice.
2. A records manager signs each class they use, citing the real authority reference and whether it is permanent.
3. The organisation needs two different people who hold `retention:manage` before a purge or anonymise policy can become active.
4. Apply the database migration in each environment. Do not use `db:push`.
5. Policies that were active before this change have no approver, so the sweep skips them. Re-draft each one and have a second person activate it.
