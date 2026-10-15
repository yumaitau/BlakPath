import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import {
  emailDomain,
  hasActiveMembership,
  recordSsoSignIn,
  resolveSsoBindingById,
  resolveSsoBindingForEmail,
  type SsoBinding,
  type SsoDenialReason,
} from '@/domains/sso/sign-in';
import { CLIENT_IP_HEADER } from '@/lib/http/client-ip';
import { logger } from '@/lib/observability/logger';
import {
  idTokenSatisfiesMfa,
  registerEntraFromEnv,
  SsoMfaRequiredError,
} from './sso-entra';
import { resolveSsoProvider, type FederatedIdentity } from './sso-provider';

/**
 * Federated (tenant-bound) sign-in as a Better Auth plugin.
 *
 * Sessions are issued by Better Auth itself (`internalAdapter.createSession` +
 * `setSessionCookie`), exactly as its own sign-in endpoints do — nothing here
 * hand-rolls a session or cookie format. The flow:
 *
 *   POST /api/auth/sso/sign-in  { email }
 *     → route by email domain to an ENABLED binding whose domain is VERIFIED
 *       for that organisation; store the provider's sealed transaction in an
 *       httpOnly cookie; return the IdP URL.
 *   GET  /api/auth/sso/callback
 *     → re-check the binding, let the provider verify state/PKCE/nonce/issuer/
 *       audience/signature, map the identity to an EXISTING user with an ACTIVE
 *       membership of that organisation, then issue a session scoped to it.
 *
 * Accounts stay invite-only: federation never creates users or memberships.
 * Every outcome is audited (`auth.sign_in`, success or denied). Every failure
 * looks the same to the browser so nothing about bindings or accounts leaks.
 * IdP tokens are never persisted; only the (provider, subject) link is.
 */

const FLOW_COOKIE = 'sso_flow';
const FLOW_MAX_AGE_S = 10 * 60;
const SIGNED_IN_PATH = '/dashboard';
const FAILURE_PATH = '/sign-in?error=sso';

/** Account `providerId` for a binding: links are scoped to one tenant binding. */
export function ssoAccountProviderId(bindingId: string): string {
  return `sso:${bindingId}`;
}

/** Cookie value: `<bindingId>.<sealed transaction>`. Tampering just fails. */
export function encodeFlowCookie(bindingId: string, transaction: string): string {
  return `${bindingId}.${transaction}`;
}

export function decodeFlowCookie(
  value: string | null | undefined,
): { bindingId: string; transaction: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  return { bindingId: value.slice(0, dot), transaction: value.slice(dot + 1) };
}

function isRegistered(providerKey: string): boolean {
  return resolveSsoProvider(providerKey) !== null;
}

/**
 * Audit metadata. The auth route has already replaced forwarded headers and
 * set `CF-Connecting-IP` only to the address `clientIp` accepted, so that
 * header is the trusted client address here (absent when unverified).
 */
function requestMeta(request: Request | undefined): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: request?.headers.get(CLIENT_IP_HEADER) || null,
    userAgent: request?.headers.get('user-agent') ?? null,
  };
}

/** A denied federated sign-in, carrying the audited reason code. */
export class SsoDenied extends Error {
  constructor(readonly reason: SsoDenialReason) {
    super(reason);
  }
}

export function ssoPlugin() {
  return {
    id: 'blakpath-sso',
    endpoints: {
      ssoSignIn: createAuthEndpoint(
        '/sso/sign-in',
        {
          method: 'POST',
          body: z.object({ email: z.email().max(320) }),
        },
        async (ctx) => {
          registerEntraFromEnv();
          const unavailable = () =>
            new APIError('FORBIDDEN', {
              code: 'SSO_UNAVAILABLE',
              message: 'Single sign-on is not available for this account.',
            });
          const resolution = await resolveSsoBindingForEmail(
            ctx.body.email,
            isRegistered,
          );
          if (resolution.kind === 'denied') {
            await recordSsoSignIn({
              organisationId: resolution.organisationId,
              providerKey: resolution.providerKey,
              result: 'denied',
              reason: resolution.reason,
              ...requestMeta(ctx.request),
            });
          }
          if (resolution.kind !== 'ok') throw unavailable();
          const { binding } = resolution;
          const provider = resolveSsoProvider(binding.providerKey);
          if (!provider) throw unavailable();
          const request = await provider.start({
            organisationId: binding.organisationId,
            issuer: binding.issuer,
            clientId: binding.clientId,
            callbackUrl: `${ctx.context.baseURL}/sso/callback`,
            loginHint: ctx.body.email,
          });
          const cookie = ctx.context.createAuthCookie(FLOW_COOKIE, {
            maxAge: FLOW_MAX_AGE_S,
          });
          ctx.setCookie(
            cookie.name,
            encodeFlowCookie(binding.id, request.transaction),
            cookie.attributes,
          );
          return ctx.json({ url: request.redirectUrl });
        },
      ),

      ssoCallback: createAuthEndpoint('/sso/callback', { method: 'GET' }, async (ctx) => {
        registerEntraFromEnv();
        const callbackBase = `${ctx.context.baseURL}/sso/callback`;
        const appOrigin = new URL(ctx.context.baseURL).origin;
        const meta = requestMeta(ctx.request);
        const cookie = ctx.context.createAuthCookie(FLOW_COOKIE);
        const flow = decodeFlowCookie(ctx.getCookie(cookie.name));
        // Single use: the flow cookie is cleared whatever happens next.
        expireCookie(ctx, cookie);
        if (!flow) throw ctx.redirect(`${appOrigin}${FAILURE_PATH}`);

        let binding: SsoBinding | null = null;
        try {
          const resolution = await resolveSsoBindingById(flow.bindingId, isRegistered);
          if (resolution.kind === 'none') throw new SsoDenied('VERIFICATION_FAILED');
          if (resolution.kind === 'denied') {
            await recordSsoSignIn({
              organisationId: resolution.organisationId,
              providerKey: resolution.providerKey,
              result: 'denied',
              reason: resolution.reason,
              ...meta,
            });
            throw ctx.redirect(`${appOrigin}${FAILURE_PATH}`);
          }
          binding = resolution.binding;
          const provider = resolveSsoProvider(binding.providerKey);
          if (!provider) throw new SsoDenied('PROVIDER_UNAVAILABLE');

          // Rebuild the hit URL on the configured origin (not a proxy-internal
          // host) so the token exchange presents the registered redirect_uri.
          const hit = new URL(callbackBase);
          hit.search = new URL(ctx.request?.url ?? callbackBase).search;
          let identity: FederatedIdentity;
          try {
            identity = await provider.complete({
              organisationId: binding.organisationId,
              issuer: binding.issuer,
              clientId: binding.clientId,
              callbackUrl: hit.toString(),
              state: hit.searchParams.get('state') ?? '',
              transaction: flow.transaction,
            });
          } catch (error) {
            if (
              error instanceof SsoMfaRequiredError ||
              (error instanceof Error && error.name === 'SsoMfaRequiredError')
            ) {
              throw new SsoDenied('MFA_REQUIRED');
            }
            // Messages are fixed strings (no tokens or claims) — safe to log.
            logger.warn(
              { err: error instanceof Error ? error.message : 'unknown' },
              'sso verification failed',
            );
            throw new SsoDenied('VERIFICATION_FAILED');
          }

          const adapter = ctx.context.internalAdapter;
          const userId = await resolveMember(
            { accounts: adapter, isActiveMember: hasActiveMembership },
            binding,
            identity,
          );
          const user = await adapter.findUserById(userId);
          if (!user) throw new SsoDenied('NO_ACCOUNT');
          // Scoped to the binding's tenant; membership was just verified above.
          const session = await adapter.createSession(userId, true, {
            activeOrganisationId: binding.organisationId,
          });
          await setSessionCookie(ctx, { session, user }, true);
          await recordSsoSignIn({
            organisationId: binding.organisationId,
            providerKey: binding.providerKey,
            result: 'success',
            userId,
            sessionId: session.id,
            ...meta,
          });
          throw ctx.redirect(`${appOrigin}${SIGNED_IN_PATH}`);
        } catch (error) {
          if (!(error instanceof SsoDenied)) throw error;
          if (binding) {
            await recordSsoSignIn({
              organisationId: binding.organisationId,
              providerKey: binding.providerKey,
              result: 'denied',
              reason: error.reason,
              ...meta,
            });
          }
          throw ctx.redirect(`${appOrigin}${FAILURE_PATH}`);
        }
      }),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith('/sso/'),
        window: 60,
        max: 10,
      },
    ],
  } satisfies BetterAuthPlugin;
}

/** The slice of Better Auth's internal adapter used for account linking. */
export interface SsoAccountStore {
  /** Exact (providerId, accountId) match; throws if the key is ambiguous. */
  findAccountByKey(key: {
    providerId: string;
    accountId: string;
  }): Promise<{ userId: string } | null>;
  findUserByEmail(
    email: string,
  ): Promise<{ user: { id: string; emailVerified: boolean } } | null>;
  linkAccount(account: {
    userId: string;
    providerId: string;
    accountId: string;
  }): Promise<unknown>;
}

/**
 * Map a verified identity to an existing, invited user with an ACTIVE
 * membership of the binding's organisation. The id_token must show MFA.
 * A first sign-in links by the exact email domain (the UPN the provider
 * chose); the IdP and the BlakPath user must both have verified that email.
 * Later sign-ins resolve by the stable IdP subject and still require MFA.
 * Throws {@link SsoDenied} otherwise — federation never creates accounts.
 */
export async function resolveMember(
  deps: {
    accounts: SsoAccountStore;
    isActiveMember: (userId: string, organisationId: string) => Promise<boolean>;
  },
  binding: SsoBinding,
  identity: FederatedIdentity,
): Promise<string> {
  if (!idTokenSatisfiesMfa(identity.claims)) throw new SsoDenied('MFA_REQUIRED');
  const providerId = ssoAccountProviderId(binding.id);
  const linked = await deps.accounts.findAccountByKey({
    providerId,
    accountId: identity.subject,
  });
  let userId = linked?.userId;
  if (!userId) {
    const email = identity.email?.trim().toLowerCase();
    const domain = binding.domain.trim().toLowerCase();
    if (!email || emailDomain(email) !== domain) {
      throw new SsoDenied('EMAIL_DOMAIN_MISMATCH');
    }
    if (!identity.emailVerified) throw new SsoDenied('EMAIL_UNVERIFIED');
    const found = await deps.accounts.findUserByEmail(email);
    if (!found) throw new SsoDenied('NO_ACCOUNT');
    if (!found.user.emailVerified) throw new SsoDenied('EMAIL_UNVERIFIED');
    userId = found.user.id;
  }
  if (!(await deps.isActiveMember(userId, binding.organisationId))) {
    throw new SsoDenied('NO_ACTIVE_MEMBERSHIP');
  }
  if (!linked) {
    await deps.accounts.linkAccount({ userId, providerId, accountId: identity.subject });
  }
  return userId;
}
