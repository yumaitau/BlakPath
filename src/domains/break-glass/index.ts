/**
 * Break-glass domain (Phase 7) — emergency, time-boxed, cross-tenant READ
 * access with separation of duties and full audit.
 */
export {
  BREAK_GLASS_REVIEW_BUSINESS_DAYS,
  BREAK_GLASS_REVIEW_TIME_ZONE,
  BREAK_GLASS_STATUSES,
  addBusinessDays,
  canApprove,
  canDeny,
  canActivate,
  canRevoke,
  canReview,
  isLive,
  isReviewOverdue,
  isTerminal,
  type BreakGlassStatus,
} from './status';

export {
  projectBreakGlassApplication,
  projectBreakGlassEvidence,
  type BreakGlassApplicationView,
  type BreakGlassEvidenceView,
} from './access-view';

export {
  denyBreakGlassSchema,
  requestBreakGlassSchema,
  reviewBreakGlassSchema,
  type DenyBreakGlassInput,
  type RequestBreakGlassInput,
  type ReviewBreakGlassInput,
} from './schemas';

export {
  BreakGlassError,
  BreakGlassNotifyError,
  BreakGlassReviewOverdueError,
  activateBreakGlass,
  approveBreakGlass,
  breakGlassReviewOverdue,
  denyBreakGlass,
  listBreakGlassAudit,
  listBreakGlassRequests,
  listOwnBreakGlassRequests,
  requestBreakGlass,
  resolveBreakGlassContext,
  reviewBreakGlass,
  revokeBreakGlass,
  type BreakGlassAuditItem,
  type BreakGlassRow,
} from './service';
