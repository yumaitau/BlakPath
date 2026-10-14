/** SSO domain — tenant IdP bindings over the provider registry. */
export {
  createSsoBinding,
  listSsoBindings,
  setSsoBindingEnabled,
  type SsoBindingRow,
} from './service';
export {
  emailDomain,
  hasActiveMembership,
  recordSsoSignIn,
  resolveSsoBindingById,
  resolveSsoBindingForEmail,
  selectSsoBinding,
  type SsoBinding,
  type SsoBindingCandidate,
  type SsoBindingResolution,
  type SsoDenialReason,
} from './sign-in';
