/**
 * Applications domain (Phase 2).
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `workflow` — the pure status/transition state machine (single source of
 *     truth for legal moves).
 *   - `schemas`  — zod v4 input validation for every write path.
 *   - `policies` — pure contextual read policies (read-any/assigned/own).
 *   - `service`  — the tenant-scoped, permission-checked, audited read/write
 *     path.
 */
export {
  ACTIVE_STATUSES,
  APPLICATION_STATUSES,
  ApplicationWorkflowError,
  TERMINAL_STATUSES,
  TRANSITIONS,
  availableActions,
  canTransition,
  isTerminal,
  nextStatus,
  permissionsForAction,
  type ApplicationAction,
  type ApplicationStatus,
  type TransitionDef,
} from './workflow';

export {
  addNoteSchema,
  assignApplicationSchema,
  createApplicationSchema,
  listApplicationsSchema,
  transitionApplicationSchema,
  updateIntakeSchema,
  type AddNoteInput,
  type AssignApplicationInput,
  type CreateApplicationInput,
  type ListApplicationsInput,
  type TransitionApplicationInput,
  type UpdateIntakeInput,
} from './schemas';

export {
  canReadAnyApplication,
  canReadApplication,
  canReadAssignedApplication,
  canReadOwnApplication,
  readsAllApplications,
  subjectCanReadApplication,
  type ApplicationReadResource,
} from './policies';

export {
  addNote,
  applyApplicationTransition,
  assignApplication,
  createApplication,
  getApplication,
  getApplicationCaseRecord,
  listApplicationParticipants,
  listApplications,
  recordApplicationTransitionAudit,
  transitionApplication,
  updateIntake,
  type AppliedApplicationTransition,
  type ApplicationAssignmentRow,
  type ApplicationCaseRecord,
  type ApplicationDetail,
  type ApplicationNoteRow,
  type ApplicationParticipant,
  type ApplicationRow,
  type ApplicationStatusHistoryRow,
} from './service';
