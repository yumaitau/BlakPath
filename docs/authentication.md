# Authentication

BlakPath uses **Better Auth** (v1) with its Drizzle adapter. The auth tables in
`src/db/schema/auth.ts` follow Better Auth's core shape (`user`, `session`,
`account`, `verification`) plus the **passkey** and **two-factor** plugin tables.
The Drizzle snake_case mapper handles DB naming.

Authentication answers "who are you". It does **not** grant access to any tenant
data on its own — that comes from a DB-verified membership plus permissions
(`docs/authorization-matrix.md`, `docs/tenant-isolation.md`).

## Tables and what they hold

| Table           | Better Auth model | Notes                                                                                          |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `users`         | `user`            | Account identity. `isPlatformOperator` marks BlakPath staff and grants **no** tenant access.   |
| `accounts`      | `account`         | Credential/OAuth links. `password` is **Better-Auth-hashed** (argon2) — never plaintext.       |
| `sessions`      | `session`         | Active sessions. `activeOrganisationId` is advisory; `lastAuthenticatedAt` drives step-up.     |
| `verifications` | `verification`    | Single-use, expiring values for email verification, reset, OTP.                                |
| `passkeys`      | passkey plugin    | WebAuthn credentials; **public key only**, no private material stored.                         |
| `twoFactors`    | twoFactor plugin  | TOTP `secret` and `backupCodes` stored **envelope-encrypted (AES-256-GCM)** — ciphertext only. |

## Better Auth setup

- **Adapter:** Better Auth's Drizzle adapter over the shared `db` instance
  (`src/db/client.ts`).
- **Secret & URL:** `BETTER_AUTH_SECRET` (>= 32 chars) and `BETTER_AUTH_URL`,
  read via the validated `env` (`src/lib/env.ts`) — never `process.env` directly.
- **Password hashing:** argon2 (`@node-rs/argon2`); this schema never sees a
  plaintext credential.
- **Plugins enabled:** email/password, email verification, password reset,
  **passkey** (WebAuthn), **two-factor** (TOTP + recovery codes).
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
- **TOTP** two-factor with **recovery codes**. The TOTP secret and recovery codes
  are envelope-encrypted before they touch `twoFactors`.

## Staff MFA requirement

**Every organisation staff member must have a second factor** (a passkey, or TOTP
with recovery codes) before they can act on tenant data. Sign-in for a staff
account that has not completed MFA enrolment is routed to enrolment, not to the
workspace. Applicants using the public application flow are encouraged, but not
forced, to enable MFA. Platform operators must use MFA unconditionally.

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
- Sessions can be listed and revoked by the user; changing a password or a
  security factor invalidates other sessions.
- `lastAuthenticatedAt` records the most recent successful authentication and
  gates step-up (below).

## Step-up / re-authentication for sensitive actions

Certain actions require a **recent** authentication, not just a valid session.
Before performing one, the app checks `sessions.lastAuthenticatedAt` against a
freshness window; if stale, the user must re-authenticate (password + second
factor, or passkey) which refreshes the timestamp.

Actions requiring step-up include: recording a determination (`decision:record`),
issuing/revoking a certificate (`certificate:issue` / `certificate:revoke`),
managing security-sensitive settings, changing MFA factors, and **all break-glass
operations** (`break_glass_requests.stepUpVerified` must be true).

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

- **Recovery codes** are issued at TOTP enrolment, envelope-encrypted, and each
  is single-use. Using one is an audited event.
- Repeated failed attempts are rate-limited (Redis-backed, tenant/identity
  prefixed) to slow credential-stuffing.
- Account recovery that would reset a factor is treated as sensitive and audited;
  it never silently disables MFA for staff.

## SSO / SCIM (future abstraction)

Enterprise sign-on is not in Phase 1, but the design leaves room for it:

- **SSO (OIDC/SAML):** `accounts` already models federated providers
  (`providerId`, tokens), so an OIDC/SAML provider slots in as another account
  type. Organisation-to-provider mapping will hang off the tenancy domain (e.g.
  via `organisation_domains` for email-domain routing).
- **SCIM provisioning:** membership lifecycle already lives in `memberships` /
  `membership_roles` with clear statuses, so SCIM create/update/deactivate maps
  onto membership status transitions rather than a parallel identity store.

Neither changes the invariant: **authentication never bypasses tenant isolation
or permission checks**, and every sign-in and factor change is audited
(`docs/audit-log-design.md`).
