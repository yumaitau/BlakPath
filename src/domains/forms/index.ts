/**
 * Forms domain — custom form builder with tokenised, unauthenticated completion.
 *
 *   - field engine lives in `@/lib/forms/fields` (pure).
 *   - `schemas` — zod v4 authoring input validation.
 *   - `service` — staff authoring (tenant-scoped, audited) + the public token
 *     path (`getPublicForm`, `submitPublicResponse`).
 */
export {
  createFormSchema,
  createInvitationSchema,
  updateFormSchema,
  type CreateFormInput,
  type CreateInvitationInput,
  type UpdateFormInput,
} from './schemas';

export {
  FormTokenError,
  closeForm,
  createForm,
  createInvitation,
  getForm,
  getPublicForm,
  listForms,
  listInvitations,
  listResponses,
  publishForm,
  revokeInvitation,
  submitPublicResponse,
  updateForm,
  type FormInvitationRow,
  type PublicFormInvitation,
  type FormResponseRow,
  type FormRow,
  type PublicForm,
} from './service';
