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
  linkResponseSchema,
  publicFileUploadSchema,
  updateFormSchema,
  type CreateFormInput,
  type CreateInvitationInput,
  type LinkResponseInput,
  type PublicFileUploadInput,
  type UpdateFormInput,
} from './schemas';

export {
  FormResponseLinkError,
  FormTokenError,
  attachResponseToCase,
  closeForm,
  completePublicFileUpload,
  createCaseFromResponse,
  createForm,
  createInvitation,
  getForm,
  getPublicForm,
  listForms,
  listInvitations,
  listResponses,
  listResponsesForApplication,
  publishForm,
  requestPublicFileUpload,
  revokeInvitation,
  savePublicDraft,
  submitPublicResponse,
  updateForm,
  type CaseFormResponse,
  type FormInvitationRow,
  type PublicFormInvitation,
  type FormResponseRow,
  type FormRow,
  type PublicForm,
  type PublicFormDraft,
} from './service';
