import { createHash } from 'node:crypto';
import type { SettingsField } from './schemas';
import {
  brandingSchema,
  consentWordingSchema,
  escalationContactsSchema,
  evidenceRequirementsSchema,
  fieldSchemas,
  guidanceSchema,
  retentionDefaultsSchema,
  terminologySchema,
} from './schemas';

/**
 * Non-PII before/after snapshots for organisation settings.
 *
 * Free text and contact details stay out of the audit trail. A SHA-256 digest
 * still changes when the stored value changes, so a reviewer can see that a
 * field moved without reading the wording or a person's name, email or phone.
 */

const AUDIT_ALLOW = ['field', 'present', 'digest', 'summary'] as const;

type SummaryValue =
  | string
  | number
  | boolean
  | null
  | SummaryValue[]
  | { [key: string]: SummaryValue };

export interface SettingsAuditMeta {
  readonly data: {
    field: SettingsField;
    present: boolean;
    digest: string;
    summary: Record<string, SummaryValue>;
  };
  readonly allow: typeof AUDIT_ALLOW;
}

/** Stable JSON for digests and equality. Object keys are sorted. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Drop strings that look like an email address or a long digit run. */
function safeText(value: string, max = 200): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('@') || /\d{6,}/.test(trimmed))
    return null;
  return trimmed.slice(0, max);
}

function meta(
  field: SettingsField,
  present: boolean,
  digestValue: string,
  summary: Record<string, SummaryValue>,
): SettingsAuditMeta {
  return {
    data: { field, present, digest: digestValue, summary },
    allow: AUDIT_ALLOW,
  };
}

function summarise(field: SettingsField, value: unknown): Record<string, SummaryValue> {
  switch (field) {
    case 'terminology': {
      const terms = terminologySchema.parse(value);
      const keys = Object.keys(terms).sort();
      const labels: Record<string, SummaryValue> = {};
      for (const key of keys) {
        const label = safeText(terms[key] ?? '');
        if (label) labels[key] = label;
      }
      return { keyCount: keys.length, labels };
    }
    case 'branding': {
      const branding = brandingSchema.parse(value);
      return {
        ...(branding.primaryColor
          ? { primaryColor: branding.primaryColor.toLowerCase() }
          : {}),
        hasLogoRef: Boolean(branding.logoRef),
      };
    }
    case 'publicGuidance':
    case 'eligibilityGuidance': {
      const guidance = guidanceSchema.parse(value);
      return {
        bodyLength: guidance.body.length,
        ...(guidance.title ? { titleLength: guidance.title.length } : {}),
      };
    }
    case 'evidenceRequirements': {
      const requirements = evidenceRequirementsSchema.parse(value);
      const labels = requirements.items
        .map((item) => safeText(item.label))
        .filter((label): label is string => label !== null);
      return {
        itemCount: requirements.items.length,
        labels,
        ...(requirements.intro ? { introLength: requirements.intro.length } : {}),
      };
    }
    case 'consentWording': {
      const consent = consentWordingSchema.parse(value);
      const version = consent.version ? safeText(consent.version, 40) : null;
      return {
        bodyLength: consent.body.length,
        ...(consent.title ? { titleLength: consent.title.length } : {}),
        ...(version ? { version } : {}),
      };
    }
    case 'retentionDefaults': {
      const retention = retentionDefaultsSchema.parse(value);
      return {
        ...(retention.applicationDays !== undefined
          ? { applicationDays: retention.applicationDays }
          : {}),
        ...(retention.evidenceDays !== undefined
          ? { evidenceDays: retention.evidenceDays }
          : {}),
        ...(retention.decisionDays !== undefined
          ? { decisionDays: retention.decisionDays }
          : {}),
        ...(retention.certificateDays !== undefined
          ? { certificateDays: retention.certificateDays }
          : {}),
      };
    }
    case 'escalationContacts': {
      const contacts = escalationContactsSchema.parse(value);
      return {
        count: contacts.contacts.length,
        roles: contacts.contacts.map((contact) => safeText(contact.role) ?? '[withheld]'),
      };
    }
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/**
 * Snapshot one settings field for `recordAudit`.
 * Unreadable stored JSON is digested and flagged, never copied.
 */
export function settingsAuditMeta(
  field: SettingsField,
  value: unknown,
): SettingsAuditMeta {
  if (value === null || value === undefined) {
    return meta(field, false, digest(null), {});
  }
  const parsed = fieldSchemas[field].safeParse(value);
  if (!parsed.success) {
    return meta(field, true, digest(value), { unreadable: true });
  }
  return meta(field, true, digest(parsed.data), summarise(field, parsed.data));
}
