# Request limits

Limits are counted in Redis and shared by every app replica. A store error
denies the request. The client address is `cf-connecting-ip` only. That header
is the client because the load balancer accepts Cloudflare ranges and nothing
else (`infra/k8s/service-ingress.yaml`, `inbound-cidrs`). Do not widen those
ranges, and do not key limits on `x-forwarded-for`.

Auth windows are enforced by Better Auth with the same Redis counter. Other
routes enforce the table below. `/form/:token`, `/verify/:code` and `/c/:token` are limited
in `src/proxy.ts` so the response is HTTP 429 before the page renders. The
pages do not count a second time.

Each row is two buckets. Both must pass. The second bucket is a hash of the
token or secret, or the API key's database id — never the raw key. A request
with no credential still spends the IP bucket.

Windows are 60 seconds.

| Route                                                | IP  | Second bucket           |
| ---------------------------------------------------- | --- | ----------------------- |
| Sign-in, sign-up                                     | 5   | —                       |
| Forgot / request password reset                      | 3   | —                       |
| Reset password, TOTP, backup code                    | 5   | —                       |
| Other auth routes                                    | 100 | —                       |
| `POST /api/membership-invitations/create-account`    | 5   | invitation token, 5     |
| `POST /api/public/forms/[token]`                     | 20  | form token, 10          |
| `GET /form/[token]`                                  | 60  | form token, 30          |
| `GET /verify/[code]`                                 | 30  | verification code, 15   |
| `GET /c/[token]`                                     | 30  | letter token, 15        |
| `GET /api/public/correspondence/[token]/certificate` | 30  | letter token, 15        |
| `POST /api/membership-invitations/accept`            | 10  | invitation token, 5     |
| `/api/v1/*`                                          | 60  | API key id, 120         |
| `POST /api/mcp`                                      | 30  | API key id, 60          |
| `/api/scim/v2/*`                                     | 20  | bearer hash, 60         |
| `POST /api/email/events`                             | 30  | webhook secret hash, 60 |

A 429 body is `{ "error": "Too many requests" }` with `Retry-After` and
`X-Retry-After`.

Sign-in also delays, then locks, one account after repeated failures. The
counter is an HMAC of the normalised email. It does not include the client
address, so failures from many addresses still add up, and a different account
is unaffected. With 0–3 failures already recorded, the next attempt is not
delayed. With 4–6 it waits 400 ms. With 7–9 it waits 1.2 s. The 10th failure
locks the account for 15 minutes, and the next attempt is rejected before the
password is checked. A correct password, a second-factor challenge, or an
unverified-email block clears the counter. The numbers live in `SIGN_IN_GUARD`.

A completed password reset revokes existing sessions for that account.
Reset mail is queued on `auth-email` and the HTTP handler spends a fixed
budget so the response time does not depend on the mail relay.

`infra/cloudflare/waf-rate-limits.example.yaml` is an outer layer, slightly
looser than this table and keyed only by source IP. A human applies it.
Applying it does not replace the limits in this document.
