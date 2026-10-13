/**
 * Individual-rights rules — pure and testable.
 *
 * Request types, statutory response periods, due-date arithmetic, status
 * transitions and the complaint escalation wording. No IO.
 *
 * PRODUCT INVARIANT: handling a rights request is a recorded human act. Nothing
 * here scores, ranks or infers anything about a person.
 */

export const RIGHTS_REQUEST_TYPES = [
  'access',
  'correction',
  'complaint',
  'withdrawal',
  'erasure',
] as const;
export type RightsRequestType = (typeof RIGHTS_REQUEST_TYPES)[number];

export const RIGHTS_REQUEST_STATUSES = [
  'received',
  'in_progress',
  'completed',
  'refused',
  'withdrawn',
] as const;
export type RightsRequestStatus = (typeof RIGHTS_REQUEST_STATUSES)[number];

/** Statuses that end a request. A closed request cannot be acted on further. */
export const CLOSED_STATUSES: readonly RightsRequestStatus[] = [
  'completed',
  'refused',
  'withdrawn',
];

export function isClosedStatus(status: RightsRequestStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * Response period and legal basis per request type.
 *
 * Defaults follow the Privacy Act 1988 (Cth): APP 12.4 and APP 13.5 require a
 * response within 30 days, and the OAIC expects complaints and consent
 * withdrawals to be answered in the same period. State and territory regimes
 * that bind councils (for example the PPIP Act 1998 (NSW) or the IP Act 2009
 * (Qld)) can set other periods; an organisation records an extension with a
 * reason rather than editing these defaults.
 */
export const STATUTORY_PERIODS: Readonly<
  Record<RightsRequestType, { readonly days: number; readonly basis: string }>
> = {
  access: { days: 30, basis: 'APP 12.4 — respond to an access request within 30 days' },
  correction: {
    days: 30,
    basis: 'APP 13.5 — respond to a correction request within 30 days',
  },
  complaint: {
    days: 30,
    basis: 'OAIC guidance — respond to a privacy complaint within 30 days',
  },
  withdrawal: {
    days: 30,
    basis: 'APP 3 and 6 — stop relying on withdrawn consent; confirm within 30 days',
  },
  erasure: {
    days: 30,
    basis: 'APP 11.2 — destroy or de-identify information no longer needed',
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The statutory due date for a request received at `receivedAt`. */
export function statutoryDueDate(type: RightsRequestType, receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + STATUTORY_PERIODS[type].days * DAY_MS);
}

/** Whole days until `dueAt` (negative once overdue). */
export function daysRemaining(dueAt: Date, now: Date): number {
  return Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS);
}

/** An open request is overdue once its due date has passed. */
export function isOverdue(
  request: { status: RightsRequestStatus; dueAt: Date },
  now: Date,
): boolean {
  if (isClosedStatus(request.status)) return false;
  return request.dueAt.getTime() < now.getTime();
}

/** Legal status moves. Closed requests are final; reopening means a new request. */
const TRANSITIONS: Readonly<Record<RightsRequestStatus, readonly RightsRequestStatus[]>> =
  {
    received: ['in_progress', 'completed', 'refused', 'withdrawn'],
    in_progress: ['completed', 'refused', 'withdrawn'],
    completed: [],
    refused: [],
    withdrawn: [],
  };

export function canTransition(
  from: RightsRequestStatus,
  to: RightsRequestStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * Escalation wording for complaints. Shown to staff when a complaint is logged
 * and included in every complaint response so the person knows where to go if
 * they are not satisfied.
 */
export const COMPLAINT_ESCALATION_TEXT = [
  'If you are not satisfied with how we handled your complaint, or we have not responded within 30 days, you can take it to a privacy regulator.',
  'Office of the Australian Information Commissioner (OAIC): www.oaic.gov.au, 1300 363 992. The OAIC handles complaints about organisations and Australian Government agencies covered by the Privacy Act 1988, and about ACT public sector agencies.',
  'If we are a state or territory body, such as a local council, contact the regulator for that state or territory:',
  'NSW — Information and Privacy Commission (www.ipc.nsw.gov.au).',
  'Victoria — Office of the Victorian Information Commissioner (www.ovic.vic.gov.au).',
  'Queensland — Office of the Information Commissioner (www.oic.qld.gov.au).',
  'Western Australia — Office of the Information Commissioner (www.oic.wa.gov.au).',
  'South Australia — Privacy Committee of South Australia (www.archives.sa.gov.au).',
  'Tasmania — Ombudsman Tasmania (www.ombudsman.tas.gov.au).',
  'Northern Territory — Information Commissioner (www.infocomm.nt.gov.au).',
].join('\n');

/** The escalation text for a request, or null when the type has none. */
export function escalationTextFor(type: RightsRequestType): string | null {
  return type === 'complaint' ? COMPLAINT_ESCALATION_TEXT : null;
}
