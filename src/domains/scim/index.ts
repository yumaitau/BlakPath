/** SCIM domain — per-organisation directory provisioning. */
export {
  createScimCredential,
  listScimCredentials,
  revokeScimCredential,
  rotateScimCredential,
  type ScimCredentialRow,
} from './credentials';
export { diffRoleIds, mapGroupsToRoles, scimControllableRoles } from './roles';
export {
  authenticateScim,
  provisionScimUser,
  revokeScimUser,
  setScimUserActive,
  type ScimPrincipal,
} from './service';
export { type ScimUserInput } from './schemas';
export {
  generateScimToken,
  hashScimToken,
  looksLikeScimToken,
  scimDisplayPrefix,
  SCIM_TOKEN_PREFIX,
} from './tokens';
