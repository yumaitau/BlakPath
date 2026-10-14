# Authentication

BlakPath uses **Better Auth** (v1) with its Drizzle adapter. The auth tables in
`src/db/schema/auth.ts` follow Better Auth's core shape (`user`, `session`,
`account`, `verification`) plus the **passkey** and **two-factor** plugin tables.
The Drizzle snake_case mapper handles DB naming.

Authentication answers "who are you". It does **not** grant access to any tenant
data on its own — that comes from a DB-verified membership plus permissions
(`docs/authorization-matrix.md`, `docs/tenant-isolation.md`).

## Tables and what they hold

| Table           | Better Auth model | Notes                                                                                                                                                                                                                                                              |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`         | `user`            | Account identity. `isPlatformOperator` marks BlakPath staff and grants **no** tenant access. `twoFactorEnabled` is set only after a TOTP code is confirmed.                                                                                                        |
| `accounts`      | `account`         | Credential/OAuth links. `password` is **Better-Auth-hashed** (argon2) — never plaintext.                                                                                                                                                                           |
| `sessions`      | `session`         | Active sessions. `activeOrganisationId` is advisory; `lastAuthenticatedAt` drives step-up.                                                                                                                                                                         |
| `verifications` | `verification`    | Single-use, expiring values for email verification, reset, OTP.                                                                                                                                                                                                    |
| `passkeys`      | passkey plugin    | WebAuthn credentials; **public key only**, no private material stored. Includes the authenticator `aaguid`.                                                                                                                                                        |
| `twoFactors`    | twoFactor plugin  | TOTP `secret` and `backupCodes` encrypted by Better Auth 1.6 (`symmetricEncrypt`: XChaCha20-Poly1305 under SHA-256 of `BETTER_AUTH_SECRET`). Not `encryptField` and not KMS. `verified`, `failedVerificationCount` and `lockedUntil` record enrolment and lockout. |

## Better Auth setup

- **Adapter:** Better Auth's Drizzle adapter over the shared `db` instance
  (`src/db/client.ts`).
- **Secret & URL:** `BETTER_AUTH_SECRET` (>= 32 chars) and `BETTER_AUTH_URL`,
  read via the validated `env` (`src/lib/env.ts`) — never `process.env` directly.
- **Password hashing:** argon2 (`@node-rs/argon2`); this schema never sees a
  plaintext credential.
- **Plugins enabled:** email/password, email verification, password reset,
  **passkey** (WebAuthn), **two-factor** (TOTP + recovery codes).
- **Schema coverage:** startup and `pnpm test` compare those plugins' fields
  with the Drizzle auth tables (`src/lib/auth/schema-coverage.ts`). A missing
  field refuses to boot. The adapter would otherwise drop the write.
- **Region:** all auth data resides in `ap-southeast-2` like the rest of the
  platform (`docs/privacy-architecture.md`).

## Supported methods

- **Invite-only accounts.** Open self-registration is disabled
  (`disableSignUp`). A person without an account creates one from inside a
  pending organisation invitation (`createInvitedAccount`), which binds
  creation to the invited email and marks it verified — the invitation token
  proves inbox control. Afterwards the invitation is accepted normally
  (verified-email match, single active membership, audited).
- **Email + password**, with mandatory **email verification** before an account
  is usable, and secure **password reset** — both via single-use expiring
  `verifications` values delivered over SMTP (Mailpit locally).
- **Passkeys (WebAuthn)** — phishing-resistant, preferred for staff. Only the
  COSE public key, credential id and counter are stored (`passkeys`).
- **TOTP** two-factor with **recovery codes**. Better Auth encrypts the TOTP
  secret and the backup codes with `symmetricEncrypt` before they are written
  to `twoFactors`. The key is SHA-256(`BETTER_AUTH_SECRET`). BlakPath's
  `encryptField` helper is not on this path.

## Staff MFA requirement

**Every organisation staff member must have a second factor** (a passkey, or TOTP
with recovery codes) before they can act on tenant data. A TOTP row counts only
after the user confirms a code (`two_factors.verified`). Sign-in for a staff
account that has not completed that enrolment is routed to `/mfa/enrol`, not to
the workspace. The staff shell and `withTenant` (every tenant `/api/*` handler)
enforce this before any tenant work runs, and a refusal is audited. Applicants
using the public application flow are encouraged, but not forced, to enable MFA.
Platform operators must use MFA unconditionally.

## Organisation invitations

- An authorised organisation administrator creates an invitation for one email
  address, one initial role and one organisation. The browser never supplies the
  organisation during acceptance.
- `membership_invitations` stores only a SHA-256 hash of the single-use token.
  Resending rotates the token and invalidates the previous link; cancellation,
  acceptance and expiry are retained as access history.
- Acceptance requires a signed-in account with the same verified email address.
  Only then is an active membership and role created for the invitation's
  organisation. The current session is moved into that verified tenant context.
- Invitation, acceptance, cancellation, role, suspension and revocation attempts
  are permission-checked and audited, including policy denials. Self-lockout and
  removal or downgrade of the final active organisation administrator are denied.

## Session management

- Sessions are server-side (`sessions` table), keyed by a unique `token`, with an
  `expiresAt` and captured `ipAddress`/`userAgent`.
- `activeOrganisationId` records which tenant a session is currently acting
  within — **advisory only.** Every request re-derives and DB-verifies the tenant
  context regardless (`docs/tenant-isolation.md`).
- Sessions can be listed and revoked by the user. Completing a password reset
  revokes existing sessions for that account (`revokeSessionsOnPasswordReset`).
  Changing a security factor invalidates other sessions.
- A session with an active organisation expires 12 hours after it is created.
  It also expires after an idle period of 30–60 minutes (default 45). An
  organisation administrator with `tenant:configure` sets that period with
  `PATCH /api/organisations/session-policy` (`idleTimeoutMinutes`). `GET` on
  the same path returns the resolved timeout in seconds. Sessions with no
  active organisation keep the 7-day ceiling.
- Idle is measured from the session row's `updatedAt`. Activity older than 60
  seconds refreshes `expiresAt` to the sooner of the 12-hour cap and now plus
  the idle timeout. An idle or over-age staff session is deleted; the person
  must sign in again.
- `lastAuthenticatedAt` records the most recent successful authentication and
  gates step-up (below). A null value falls back to `createdAt`.
- Cookie-authenticated `/api` mutations must come from the `APP_URL` origin
  with `Content-Type: application/json`. Bearer, Better Auth, SCIM, provider
  webhooks, token-addressed public forms and the CSP report sink are exempt.
- Production session cookies use the `__Host-` prefix (`Secure`, `Path=/`, no
  `Domain`), so they cannot be issued for a parent domain. Development keeps
  the `blakpath` prefix without `Secure` so plain HTTP on a non-loopback host
  can still sign in.

### Expiry, return-to and inactivity in the staff UI

- An expired session never strands the user. The staff layout and staff pages
  redirect to `/sign-in?returnTo=<current page>&reason=expired`; the current
  page path reaches server components through `src/proxy.ts`
  (`x-blakpath-path`), which makes no access decision. After sign-in (including
  the two-factor step) the user lands back on that page.
- `returnTo` is untrusted input: `safeReturnTo` (`src/lib/auth/return-to.ts`)
  only accepts same-origin relative paths and refuses absolute or
  protocol-relative URLs, backslash tricks, control characters, `/api/*`,
  `/_next/*` and the auth pages themselves. Anything else falls back to
  `/dashboard`.
- Client components: the staff shell wraps `fetch` once. A `401` from our own
  API (outside `/api/auth/*`) sends the user to sign-in with `returnTo`. A
  step-up refusal is also a `401` but carries `code: "STEP_UP_REQUIRED"`, so the
  component handles it instead.
- Inactivity: after `STAFF_IDLE_TIMEOUT_MINUTES` (default 30, 5-720) without
  activity in any open tab, the UI revokes the session through Better Auth and
  returns to sign-in (`reason=idle`). A warning dialog with a countdown appears
  two minutes before, and "Stay signed in" resets the timer. This is a
  convenience control on shared devices. The server-side session lifetime is
  still the security boundary.
- Staff pages tell failures apart. An expired session redirects to sign-in, a
  missing organisation goes to the organisation picker, an access refusal shows
  an in-page **403** state, and anything else reaches the branded **500** error
  page with a support reference (see `docs/operations-runbook.md`).

## Step-up / re-authentication for sensitive actions

Certain actions require a **recent** authentication, not just a valid session.
The route map is `STEP_UP_ROUTES` in `src/lib/auth/step-up-policy.ts`. Windows
are 5 minutes (privileged), 10 minutes (sensitive actions such as evidence
download, export, and certificate revocation), and 15 minutes (destructive
retention changes).

Before the handler reads params or a body, it checks `lastAuthenticatedAt`
(or `createdAt` when that is null). A stale session gets HTTP 401 with
`code: "STEP_UP_REQUIRED"`. The staff UI then asks for the password and, when
an authenticator is enrolled, a TOTP or backup code — or a passkey. That check
mints a new session and retries the action. It does not sign the person out.

The mapped routes are evidence download, report export create and download,
certificate revoke, meeting pack read, API key create, webhook create, SSO provider create,
retention hold release, retention policy delete, and break-glass deny and
revoke. Certificate signing, break-glass approval and activation, and
membership changes are gated the same way.

Re-authentication stamps `lastAuthenticatedAt` on the new session.

## Authentication sequence

```mermaid
sequenceDiagram
  participant U as User (browser)
  participant App as Next.js app
  participant BA as Better Auth
  participant DB as PostgreSQL

  U->>App: Submit email + password
  App->>BA: signIn(email, password)
  BA->>DB: Load account, verify argon2 hash
  alt email not verified
    BA-->>U: Blocked → resend verification link
  else credentials valid
    alt second factor required (staff)
      BA-->>U: Prompt for passkey or TOTP
      U->>App: Provide passkey assertion / TOTP code
      App->>BA: Verify factor (TOTP decrypted in-memory only)
      BA->>DB: Validate; update lastAuthenticatedAt
    end
    BA->>DB: Create session (token, expiresAt)
    BA-->>U: Set session cookie
  end

  Note over U,DB: Later — a sensitive action
  U->>App: Request decision:record
  App->>DB: Check lastAuthenticatedAt freshness
  alt stale
    App-->>U: Step-up re-auth required
    U->>App: Re-authenticate → refresh lastAuthenticatedAt
  end
  App->>App: Proceed (permission-checked + audited)
```

## Recovery and lockout

- **Recovery codes** are issued at TOTP enrolment, stored as Better Auth
  ciphertext (see the table above), and each is single-use. Using one is an
  audited event.
- Repeated failed sign-in attempts are limited per client address and, separately,
  delayed then locked per account. The counters live in Redis and are shared
  across replicas. See `docs/rate-limits.md`. The address in the bucket is
  `clientIp`: `CF-Connecting-IP` after the origin-verify secret matches. A
  client-supplied forwarded-for value is not used. An unverified origin shares
  one bucket instead of skipping the limit.
- Failed TOTP verifications are also counted on the factor row. After 10
  consecutive failures the factor stays locked for 15 minutes. A later success
  clears the count. The deadline is stored in Postgres, not only in memory.
- Password-reset mail is queued. The HTTP response does not wait on the mail
  relay, and the handler spends a fixed budget so a known address and an
  unknown address take the same time when the work finishes inside that budget.
- Account recovery that would reset a factor is treated as sensitive and audited;
  it never silently disables MFA for staff.

## SSO (Entra ID OIDC) / SCIM

Federated sign-in is tenant-bound and off unless explicitly configured:

- **Provider:** `src/lib/auth/sso-entra.ts` (authorization code + PKCE S256,
  nonce, RS256 id_token verified against the tenant JWKS, `iss`/`aud`/`exp`/
  `nbf` checks). It registers only when `SSO_ENTRA_CLIENT_ID`,
  `SSO_ENTRA_CLIENT_SECRET` and a dedicated `SSO_STATE_SECRET` are present.
  These come from Secrets Manager via the runtime secret — never the database.
- **Tenant binding:** `organisation_sso_providers` routes a verified email
  domain to a tenant-specific issuer
  (`https://login.microsoftonline.com/{tenant-id}/v2.0`, never `common`).
  The discovery document's `issuer` must equal it exactly. A binding works only
  when enabled AND its domain is verified in `organisation_domains` for the same
  organisation; otherwise the user gets one generic error, the denial is
  audited, and password + MFA remain available.
- **Flow:** `POST /api/auth/sso/sign-in { email }` → IdP →
  `GET /api/auth/sso/callback`. State, nonce and PKCE verifier are sealed
  (AES-256-GCM under `SSO_STATE_SECRET`) in a 10-minute httpOnly flow cookie,
  so a callback only completes in the browser that started it.
- **Sessions:** issued by Better Auth itself (`sso-plugin.ts`) with
  `activeOrganisationId` set to the bound tenant after an active membership
  check. Federation never creates users or memberships (invite-only): first
  sign-in links an invited, email-verified user whose UPN
  (`preferred_username`) is exactly the binding's verified domain. A divergent
  `email` claim is ignored. If Entra sends no UPN, the `email` claim is used
  only when `email_verified` or `xms_edov` is true. Later sign-ins resolve by
  IdP subject. Success and denial are audited as `auth.sign_in`.
- **Tokens:** IdP access/refresh tokens are not stored. Better Auth
  `account.encryptOAuthTokens` is on as a backstop.
- **MFA:** federated sign-in does not prompt for BlakPath TOTP or a passkey.
  The id_token must include an `amr` second factor (`mfa`, or a concrete
  method such as `otp` or `fido`). Password-only tokens, and tokens with no
  `amr` claim, are denied and audited as `MFA_REQUIRED`. The council still
  requires MFA in Entra Conditional Access for this app, and the app
  registration must emit `amr` as an optional ID token claim. A missing claim
  fails closed. A council administrator can still assign a UPN; that is the
  trust placed in the tenant. Federation does not waive the staff policy:
  staff still need an enrolled passkey or TOTP before tenant data is served.
- **SCIM provisioning:** each organisation issues its own bearer credential
  (`POST /api/scim/credentials`). Only the SHA-256 hash is stored. The
  organisation is taken from that credential; a path that names another
  organisation is rejected. Group names replace the managed role set.
  `organisation-admin` is not assignable unless the credential opts in.
  A revoked membership stays revoked. Suspend and directory delete also end
  the user's sessions.

Neither changes the invariant: **authentication never bypasses tenant isolation
or permission checks**, and every sign-in and factor change is audited
(`docs/audit-log-design.md`).
