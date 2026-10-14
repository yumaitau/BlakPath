/**
 * Correspondence domain.
 *
 * Organisation-authored templates, staff preview, and an explicit Send.
 * Outcome letters cannot be sent until a person has finalised the decision.
 * Finalising a decision does not send anything.
 *
 * PRODUCT INVARIANT: a letter reports a human act. Nothing here determines
 * Aboriginality.
 */
export {
  CORRESPONDENCE_CHANNELS,
  CORRESPONDENCE_KINDS,
  CORRESPONDENCE_STATUSES,
  MERGE_FIELDS,
  PORTAL_LINK_DAYS,
  PREVIEW_PORTAL_TEXT,
  RECORDED_OUTCOME_LABELS,
  STARTER_TEMPLATES,
  STORED_PORTAL_TEXT,
  blankMergeFields,
  emailContainsSensitiveDetail,
  emailFromIntake,
  formatCorrespondenceDate,
  maySendKind,
  mergeFieldTokens,
  minimiseEmail,
  outcomeLabel,
  renderMerge,
  sendBlock,
  starterFor,
  unknownMergeFields,
  type CorrespondenceChannel,
  type CorrespondenceKind,
  type CorrespondenceStatus,
  type MergeField,
  type MinimisedEmail,
  type SendBlock,
  type SendFacts,
  type StarterTemplate,
} from './compose';

export { CorrespondenceError, type CorrespondenceErrorCode } from './errors';

export {
  createTemplateSchema,
  draftCorrespondenceSchema,
  notifyEvidenceRequestSchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type DraftCorrespondenceInput,
  type NotifyEvidenceRequestInput,
  type UpdateTemplateInput,
} from './schemas';

export {
  createTemplate,
  draftCorrespondence,
  getLetterDownloadUrl,
  getPublicCertificateDownloadUrl,
  getPublicCorrespondence,
  listCorrespondence,
  listTemplates,
  seedStarterTemplates,
  sendCorrespondence,
  sendEvidenceRequestNotice,
  updateTemplate,
  type CorrespondenceItemRow,
  type CorrespondenceItemView,
  type CorrespondencePreview,
  type CorrespondenceTemplateRow,
  type PublicCorrespondenceView,
} from './service';
