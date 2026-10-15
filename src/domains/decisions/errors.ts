/**
 * Raised when a decision action is illegal for the case's current stage.
 *
 * This is a workflow conflict (409), not an authorisation failure: the actor
 * may hold `decision:propose`, but the case has not reached committee.
 */
export class DecisionWorkflowError extends Error {
  readonly code = 'CASE_NOT_READY_FOR_DECISION';
  readonly status = 409;

  constructor(from: string) {
    super(`Cannot propose a decision while the case is "${from}".`);
    this.name = 'DecisionWorkflowError';
  }
}
