/**
 * Enterprise SSO / provisioning abstraction.
 *
 * DESIGN INTENT (this is an extension point, NOT an insecure placeholder)
 * ----------------------------------------------------------------------
 * Phase 1 ships with email+password and MFA only. Some authorised
 * organisations will later require federated sign-in (OIDC / SAML — e.g.
 * Microsoft Entra ID, Google Workspace) and directory provisioning (SCIM).
 * This module defines the stable contract those integrations will implement and
 * a registry to look them up by key.
 *
 * The registry is deliberately EMPTY by default. That is a secure posture: with
 * no providers registered, `resolveSsoProvider` returns `null` and federated
 * sign-in is simply unavailable — there is no default, no "accept anyone",
 * no bypass of the password/MFA path. A real provider is only ever available
 * once it has been explicitly, deliberately registered.
 *
 * Provider *selection* is gated per tenant: an organisation must opt in to a
 * specific IdP and that binding must be enabled and its domain verified (see
 * `organisationDomains`) before any of its members can federate. That
 * tenant-binding logic lives in the SSO domain (`src/domains/sso/sign-in.ts`)
 * and the Better Auth plugin (`sso-plugin.ts`), not here — this file only
 * models the provider capability itself.
 */

/** The federation protocol a provider speaks. */
export type SsoProtocol = 'oidc' | 'saml' | 'scim';

/** A normalised identity asserted by an external IdP after authentication. */
export interface FederatedIdentity {
  /** Stable, provider-scoped subject identifier (the IdP's `sub` / NameID). */
  subject: string;
  /** Verified primary email, if the IdP asserts one. */
  email?: string;
  /** Whether the IdP asserts the email as verified. */
  emailVerified?: boolean;
  /** Display name, if asserted. */
  name?: string;
  /**
   * Raw provider claims, for provider-specific mapping downstream. Treated as
   * untrusted input: never used for authorisation without server-side mapping
   * and verification.
   */
  claims?: Readonly<Record<string, unknown>>;
}

/** Where to send the user to begin an interactive federated sign-in. */
export interface SsoAuthorizationRequest {
  /** Fully-formed IdP authorization URL to redirect the browser to. */
  redirectUrl: string;
  /** The `state` value sent to the IdP (CSRF protection). */
  state: string;
  /**
   * Sealed flow transaction (state, nonce, PKCE verifier, tenant, issuer). The
   * caller MUST store it in an httpOnly cookie on THIS browser and hand it back
   * to `complete` — it never travels through the IdP, which is what binds the
   * callback to the browser that started the flow.
   */
  transaction: string;
}

/** Context passed when starting an authorization flow. */
export interface SsoStartContext {
  /** The organisation this sign-in is scoped to (tenant binding). */
  organisationId: string;
  /** Tenant-specific issuer from the binding; the only issuer accepted. */
  issuer: string;
  /** Client id from the binding; providers reject one they hold no secret for. */
  clientId: string;
  /** Absolute callback URL the IdP must return to. */
  callbackUrl: string;
  /** Optional sign-in hint (the email the user entered). */
  loginHint?: string;
}

/** Context passed when completing an authorization flow. */
export interface SsoCallbackContext {
  organisationId: string;
  /** Tenant-specific issuer from the binding, re-read at callback time. */
  issuer: string;
  /** Client id from the binding. */
  clientId: string;
  /** The exact callback URL that was hit, including query parameters. */
  callbackUrl: string;
  /** The `state` value returned by the IdP, to be verified against what we issued. */
  state: string;
  /** The sealed transaction from this browser's cookie (see `start`). */
  transaction: string;
}

/**
 * The capability contract every SSO integration implements. Implementations are
 * responsible for all cryptographic verification (signature/JWKS validation,
 * audience/issuer checks, nonce/state verification) BEFORE returning a
 * `FederatedIdentity`. A returned identity is a promise that verification has
 * passed.
 */
export interface SsoProvider {
  /** Unique registry key, e.g. 'entra' or 'google'. */
  readonly key: string;
  /** Human-readable name for UI. */
  readonly displayName: string;
  readonly protocol: SsoProtocol;

  /** Begins an interactive federated sign-in. */
  start(context: SsoStartContext): Promise<SsoAuthorizationRequest>;

  /**
   * Completes the flow: verifies the IdP response and returns the asserted,
   * verified identity. MUST throw if any verification step fails.
   */
  complete(context: SsoCallbackContext): Promise<FederatedIdentity>;
}

/**
 * A SCIM directory-provisioning provider. Kept separate from interactive SSO
 * because its trust model is different (a long-lived bearer credential from the
 * IdP, not an end-user redirect flow).
 */
export interface ScimProvider {
  readonly key: string;
  readonly protocol: 'scim';
}

/**
 * Provider registry. Private map, explicit register/resolve API — no ambient
 * mutation, no default entry.
 */
const providers = new Map<string, SsoProvider>();

/**
 * Registers an SSO provider. Refuses to overwrite an existing key so a
 * mis-wired startup cannot silently shadow a configured provider.
 */
export function registerSsoProvider(provider: SsoProvider): void {
  if (providers.has(provider.key)) {
    throw new Error(`SSO provider "${provider.key}" is already registered.`);
  }
  providers.set(provider.key, provider);
}

/**
 * Resolves a provider by key. Returns `null` when none is registered — the
 * secure default. Callers MUST handle `null` by falling back to the standard
 * password/MFA path; they must never treat a missing provider as "allow".
 */
export function resolveSsoProvider(key: string): SsoProvider | null {
  return providers.get(key) ?? null;
}

/** Lists registered provider keys (for diagnostics / admin UI). Empty by default. */
export function listSsoProviders(): readonly string[] {
  return Array.from(providers.keys());
}

/** True when at least one federated provider is available. */
export function ssoEnabled(): boolean {
  return providers.size > 0;
}
