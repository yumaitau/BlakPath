import type { ResourceType } from '@/domains/audit/events';

/**
 * Disposal classification — pure catalogue.
 *
 * Every audit resource type maps to exactly one disposal class. A class says
 * what kind of record something is. It does not set a legal retention period
 * and it does not authorise destruction. A records manager signs the authority
 * reference for a class in their jurisdiction. A different person activates any
 * policy that would act on records.
 *
 * PRODUCT INVARIANT: nothing here scores, ranks, predicts or determines
 * Aboriginality. Classes describe record lifecycle only. The audit trail and
 * the destruction register are never destruction targets.
 */

/** Bump when class membership changes. Stale sign-offs then stop authorising purges. */
export const CATALOGUE_VERSION = '2026-10-13';

export const RECORDS_JURISDICTIONS = [
  'nsw',
  'vic',
  'qld',
  'wa',
  'sa',
  'tas',
  'act',
  'nt',
  'cth',
  'organisation',
] as const;
export type RecordsJurisdiction = (typeof RECORDS_JURISDICTIONS)[number];

/**
 * Labels name the statute a records manager may be working under. They are not
 * a finding that the statute applies to an organisation.
 */
export const JURISDICTION_LABELS: Record<RecordsJurisdiction, string> = {
  nsw: 'New South Wales (State Records Act 1998, including GA39 where it applies)',
  vic: 'Victoria (Public Records Act 1973 / PROS)',
  qld: 'Queensland (Public Records Act 2023)',
  wa: 'Western Australia (State Records Act 2000)',
  sa: 'South Australia (State Records Act 1997)',
  tas: 'Tasmania (Archives Act 1983)',
  act: 'Australian Capital Territory (Territory Records Act 2002)',
  nt: 'Northern Territory (Information Act 2002)',
  cth: 'Commonwealth (Archives Act 1983)',
  organisation: 'Organisation schedule (not a state records authority)',
};

export const DISPOSAL_CLASSES = [
  'application_matter',
  'supporting_evidence',
  'family_record',
  'official_outcome',
  'person_record',
  'consent_record',
  'governance_record',
  'operational_record',
  'organisation_admin',
  'security_credential',
  'export_artifact',
  'access_control',
  'retention_control',
  'key_custody',
  'search_index',
  'immutable_audit',
] as const;
export type DisposalClass = (typeof DISPOSAL_CLASSES)[number];

export const DISPOSAL_CLASS_INFO = {
  application_matter: {
    description: 'Application file, notes, forms, reviews and workflow.',
    destructionForbidden: false,
  },
  supporting_evidence: {
    description: 'Evidence uploaded in support of an application.',
    destructionForbidden: false,
  },
  family_record: {
    description: 'Family-link records supplied by people or recorded by staff.',
    destructionForbidden: false,
  },
  official_outcome: {
    description:
      'A decision or certificate recorded by authorised humans. Kept permanently unless a signed disposal authority says otherwise.',
    destructionForbidden: false,
  },
  person_record: {
    description: 'Account or client contact record. Not a determination of identity.',
    destructionForbidden: false,
  },
  consent_record: {
    description: 'Consent and representative-authorisation records.',
    destructionForbidden: false,
  },
  governance_record: {
    description: 'Meetings, agendas, packs, conflicts and votes.',
    destructionForbidden: false,
  },
  operational_record: {
    description: 'Calendar, messages, notifications and internal groups.',
    destructionForbidden: false,
  },
  organisation_admin: {
    description: 'Organisation configuration, membership and integrations.',
    destructionForbidden: false,
  },
  security_credential: {
    description: 'Sessions, authenticators and API keys.',
    destructionForbidden: false,
  },
  export_artifact: {
    description: 'Generated exports and legacy imports.',
    destructionForbidden: false,
  },
  access_control: {
    description: 'Break-glass access grants.',
    destructionForbidden: false,
  },
  key_custody: {
    description:
      'Tenant key custody, key rewraps and crypto-shred certificates. Key destruction is a custody ceremony, never a retention action.',
    destructionForbidden: true,
  },
  retention_control: {
    description: 'Retention policies, authority sign-offs and the destruction register.',
    destructionForbidden: true,
  },
  search_index: {
    description: 'Derived search entries. Not a source record.',
    destructionForbidden: false,
  },
  immutable_audit: {
    description: 'Tamper-evident audit trail. Never a retention target.',
    destructionForbidden: true,
  },
} as const satisfies Record<
  DisposalClass,
  { readonly description: string; readonly destructionForbidden: boolean }
>;

export type DisposalClassInfo = (typeof DISPOSAL_CLASS_INFO)[DisposalClass];

export const DISPOSAL_CLASS_BY_RESOURCE = {
  user: 'person_record',
  session: 'security_credential',
  mfa_method: 'security_credential',
  passkey: 'security_credential',
  organisation: 'organisation_admin',
  organisation_settings: 'organisation_admin',
  organisation_key: 'key_custody',
  organisation_key_rewrap: 'key_custody',
  destruction_certificate: 'key_custody',
  organisation_domain: 'organisation_admin',
  feature_flag: 'organisation_admin',
  role: 'organisation_admin',
  permission: 'organisation_admin',
  membership: 'organisation_admin',
  application: 'application_matter',
  evidence: 'supporting_evidence',
  record: 'application_matter',
  family_link: 'family_record',
  consent: 'consent_record',
  representative_authorisation: 'consent_record',
  workflow: 'application_matter',
  assignment: 'application_matter',
  task: 'application_matter',
  api_key: 'security_credential',
  scim_credential: 'security_credential',
  form: 'application_matter',
  form_invitation: 'application_matter',
  form_response: 'application_matter',
  review: 'application_matter',
  meeting: 'governance_record',
  agenda_item: 'governance_record',
  calendar_event: 'operational_record',
  team: 'operational_record',
  group: 'operational_record',
  client: 'person_record',
  message: 'operational_record',
  notification: 'operational_record',
  email_suppression: 'operational_record',
  meeting_pack: 'governance_record',
  conflict: 'governance_record',
  vote: 'governance_record',
  decision: 'official_outcome',
  certificate: 'official_outcome',
  export: 'export_artifact',
  import: 'export_artifact',
  retention_policy: 'retention_control',
  disposal_authority: 'retention_control',
  destruction_register: 'retention_control',
  break_glass_request: 'access_control',
  integration: 'organisation_admin',
  job: 'operational_record',
  search: 'search_index',
  audit_chain: 'immutable_audit',
} as const satisfies Record<ResourceType, DisposalClass>;

export function isRecordsJurisdiction(value: string): value is RecordsJurisdiction {
  return (RECORDS_JURISDICTIONS as readonly string[]).includes(value);
}

export function isDisposalClass(value: string): value is DisposalClass {
  return (DISPOSAL_CLASSES as readonly string[]).includes(value);
}

export function disposalClassFor(resourceType: ResourceType): DisposalClass {
  return DISPOSAL_CLASS_BY_RESOURCE[resourceType];
}

export interface DisposalCatalogueClass {
  readonly key: DisposalClass;
  readonly description: string;
  readonly destructionForbidden: boolean;
  readonly resourceTypes: readonly ResourceType[];
}

export interface DisposalCatalogue {
  readonly catalogueVersion: string;
  readonly jurisdictions: readonly { key: RecordsJurisdiction; label: string }[];
  readonly classes: readonly DisposalCatalogueClass[];
}

/** The mapping a records manager reviews before signing an authority. */
export function disposalCatalogue(): DisposalCatalogue {
  const resourceTypes = Object.keys(DISPOSAL_CLASS_BY_RESOURCE) as ResourceType[];
  return {
    catalogueVersion: CATALOGUE_VERSION,
    jurisdictions: RECORDS_JURISDICTIONS.map((key) => ({
      key,
      label: JURISDICTION_LABELS[key],
    })),
    classes: DISPOSAL_CLASSES.map((key) => ({
      key,
      description: DISPOSAL_CLASS_INFO[key].description,
      destructionForbidden: DISPOSAL_CLASS_INFO[key].destructionForbidden,
      resourceTypes: resourceTypes.filter(
        (resourceType) => DISPOSAL_CLASS_BY_RESOURCE[resourceType] === key,
      ),
    })),
  };
}
