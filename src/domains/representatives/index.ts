/** Representatives domain — consent-gated advocate access. */
export {
  REPRESENTATIVE_ACCESS_PERMISSIONS,
  REPRESENTATIVE_LIST_PERMISSIONS,
} from './permissions';

export {
  activateRepresentativeAccess,
  listRepresentativeAuthorisations,
  requestRepresentativeAccess,
  revokeRepresentativeAccess,
  type RepresentativeRow,
} from './service';
