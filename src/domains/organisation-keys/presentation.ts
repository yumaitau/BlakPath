import { parseKeyArn } from '@/lib/encryption/key-provider';
import type {
  KeyCustodyMode,
  OrganisationKeyRow,
  OrganisationKeyStatus,
} from './service';

/**
 * Pure view helpers for the "Your keys" settings page. No database, no KMS.
 * Nothing here describes a person; it describes who holds a key.
 */

export const CUSTODY_MODE_LABEL: Record<KeyCustodyMode, string> = {
  blakpath_managed: 'Managed by BlakPath',
  client_owned: 'Held by your organisation',
  client_owned_escrow: 'Held by your organisation, with BlakPath escrow',
};

export const CUSTODY_MODE_SUMMARY: Record<KeyCustodyMode, string> = {
  blakpath_managed:
    "The key is in BlakPath's AWS account. BlakPath can disable it at your written request.",
  client_owned:
    'The key is in your AWS account or external key store. You can disable it at any time, and BlakPath then cannot open your records.',
  client_owned_escrow:
    'The key is in your AWS account. An escrow copy is held by BlakPath under dual control and released only on a written request from your authorised signatories.',
};

export const KEY_STATUS_LABEL: Record<OrganisationKeyStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  pending_deletion: 'Pending deletion',
  unavailable: 'Unavailable',
};

export interface EscrowView {
  /** True when an escrow copy is recorded for this key. */
  readonly enrolled: boolean;
  /**
   * Custodian display names only, never contact details or shares. Null when
   * the key record does not carry custodian names (escrow enrolment records
   * them separately).
   */
  readonly custodianNames: readonly string[] | null;
}

function nameOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  if (entry && typeof entry === 'object' && 'name' in entry) {
    const name = (entry as { name: unknown }).name;
    return typeof name === 'string' ? name.trim() || null : null;
  }
  return null;
}

/**
 * Escrow status from the key row. Custodian names are read only if the row
 * carries an `escrowCustodians` list; other custodian fields are dropped so
 * this page can never show more than a name.
 */
export function escrowView(row: OrganisationKeyRow): EscrowView {
  const enrolled = row.escrow || row.custodyMode === 'client_owned_escrow';
  const raw: unknown = (row as OrganisationKeyRow & { escrowCustodians?: unknown })
    .escrowCustodians;
  if (!Array.isArray(raw)) return { enrolled, custodianNames: null };
  const names = raw.map(nameOf).filter((name): name is string => name !== null);
  return { enrolled, custodianNames: names };
}

export interface CloudTrailLinks {
  readonly region: string;
  readonly accountId: string;
  /** True when the key is in the client's account, so they can query it. */
  readonly clientCanQuery: boolean;
  /** CloudTrail event history in the key's account, filtered to the key. */
  readonly consoleUrl: string;
  /** Same lookup from the AWS CLI, narrowed to this organisation's context. */
  readonly cliCommand: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Links the client can follow to see every KMS call made with their key. KMS
 * logs a cross-account call in the key owner's trail as well as the caller's.
 */
export function cloudTrailLinks(
  kmsKeyArn: string,
  organisationId: string,
  custodyMode: KeyCustodyMode,
): CloudTrailLinks {
  const { region, accountId } = parseKeyArn(kmsKeyArn);
  const consoleUrl =
    `https://${region}.console.aws.amazon.com/cloudtrailv2/home?region=${region}` +
    `#/events?ResourceName=${encodeURIComponent(kmsKeyArn)}`;
  const filter =
    `.Events[].CloudTrailEvent | fromjson` +
    ` | select(.requestParameters.encryptionContext.org_id == "${organisationId}")` +
    ` | {eventTime, eventName, principal: .userIdentity.arn,` +
    ` purpose: .requestParameters.encryptionContext.purpose}`;
  const cliCommand = [
    `aws cloudtrail lookup-events --region ${region}`,
    `--lookup-attributes AttributeKey=ResourceName,AttributeValue=${kmsKeyArn}`,
    `--output json | jq -c ${shellQuote(filter)}`,
  ].join(' ');
  return {
    region,
    accountId,
    clientCanQuery: custodyMode !== 'blakpath_managed',
    consoleUrl,
    cliCommand,
  };
}

export interface KeyHistoryEvent {
  readonly id: string;
  readonly action: string;
  readonly timestamp: Date;
  readonly result: 'success' | 'failure' | 'denied';
  readonly reason: string | null;
  readonly actorName: string | null;
  readonly afterMeta: unknown;
}

export interface KeyHistoryEntry {
  readonly id: string;
  readonly at: Date;
  readonly summary: string;
  readonly result: 'success' | 'failure' | 'denied';
  /** KMS error name or similar short code. Never key material. */
  readonly detail: string | null;
  /** Display name, or "BlakPath system" when no person acted. */
  readonly actor: string;
  readonly keyVersion: number | null;
}

const ACTION_SUMMARY: Record<string, string> = {
  'key.registered': 'Key registered',
  'key.rotated': 'Key rotated',
  'key.status_changed': 'Status changed',
  'key.unavailable': 'KMS refused the key',
  'key.health_checked': 'Health check',
};

function metaNumber(meta: unknown, key: string): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** Platform-chain key events, newest first, as plain history rows. */
export function toHistoryEntries(events: readonly KeyHistoryEvent[]): KeyHistoryEntry[] {
  return events.map((event) => {
    const status = metaString(event.afterMeta, 'status');
    const base = ACTION_SUMMARY[event.action] ?? event.action;
    const summary =
      event.action === 'key.status_changed' && status && status in KEY_STATUS_LABEL
        ? `${base} to ${KEY_STATUS_LABEL[status as OrganisationKeyStatus].toLowerCase()}`
        : event.action === 'key.health_checked'
          ? `${base} ${event.result === 'success' ? 'passed' : 'failed'}`
          : base;
    return {
      id: event.id,
      at: event.timestamp,
      summary,
      result: event.result,
      detail: event.reason,
      actor: event.actorName ?? 'BlakPath system',
      keyVersion: metaNumber(event.afterMeta, 'keyVersion'),
    };
  });
}
