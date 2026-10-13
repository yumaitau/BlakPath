/**
 * Organisation settings — guidance, branding and DNS domain verification.
 */
export { OrganisationSettingsError } from './errors';

export {
  addOrganisationDomain,
  getOrganisationSettings,
  listOrganisationDomains,
  readEvidenceRequirements,
  readPublicConsentWording,
  removeOrganisationDomain,
  updateOrganisationSetting,
  verifyOrganisationDomain,
} from './service';

export {
  SETTINGS_FIELDS,
  addDomainSchema,
  consentWordingSchema,
  evidenceRequirementsSchema,
  updateSettingsSchema,
  type ConsentWording,
  type EvidenceRequirements,
  type OrganisationSettingsView,
  type SettingsField,
} from './schemas';

export { settingsAuditMeta, type SettingsAuditMeta } from './audit-meta';

export {
  domainAfterCheck,
  parseDomain,
  txtProvesControl,
  verificationHostname,
  verificationTxtValue,
  type OrganisationDomainView,
} from './dns';
