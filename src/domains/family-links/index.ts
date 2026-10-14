/**
 * Family-links domain (Phase 4).
 *
 *   - `status`  — pure requested/approved/disputed/withdrawn rules.
 *   - `schemas` — zod v4 input validation.
 *   - `service` — tenant-scoped, permission-checked, audited path with
 *     separation of duties on approval (approver ≠ requester).
 *   - `cultural-safety` — deceased-name warning copy.
 */
export {
  FAMILY_LINK_STATUSES,
  canDecide,
  canWithdraw,
  isDecided,
  type FamilyLinkStatus,
} from './status';

export {
  decideFamilyLinkSchema,
  requestFamilyLinkSchema,
  type DecideFamilyLinkInput,
  type RequestFamilyLinkInput,
} from './schemas';

export {
  DEFAULT_DECEASED_NAME_WARNING,
  deceasedNameWarningFromTerminology,
  loadDeceasedNameWarning,
} from './cultural-safety';

export {
  approveFamilyLink,
  canReadFamilyLinks,
  disputeFamilyLink,
  listFamilyLinks,
  requestFamilyLink,
  withdrawFamilyLink,
  type FamilyLinkRecord,
  type FamilyLinkRow,
} from './service';
