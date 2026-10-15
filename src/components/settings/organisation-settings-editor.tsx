'use client';

import { useState } from 'react';
import { OrganisationDomainsPanel } from '@/components/settings/organisation-domains-panel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/hooks/use-hydrated';
import type {
  OrganisationDomainView,
  OrganisationSettingsView,
  SettingsField,
} from '@/domains/organisation-settings';

type Notice = { tone: 'ok' | 'err'; text: string } | null;

export interface ReadinessChecklistView {
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly complete: boolean;
  }>;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

async function saveField(field: SettingsField, value: unknown): Promise<string | null> {
  const response = await fetch('/api/organisation-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
  if (response.ok) return null;
  if (response.status === 403) return 'No permission for that action.';
  if (response.status === 400 || response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === 'Invalid request') return 'Check the fields and try again.';
  }
  return 'Could not save. Try again.';
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === 'err' ? 'alert' : 'status'}
      className={notice.tone === 'err' ? 'text-destructive text-sm' : 'text-sm'}
    >
      {notice.text}
    </p>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border rounded-lg border p-4 sm:p-5" aria-labelledby={id}>
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function SaveBar({
  pending,
  notice,
  onSave,
}: {
  pending: boolean;
  notice: Notice;
  onSave: () => void;
}) {
  const hydrated = useHydrated();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" size="sm" disabled={!hydrated || pending} onClick={onSave}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <NoticeLine notice={notice} />
    </div>
  );
}

function AddRowButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  const hydrated = useHydrated();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!hydrated}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function TerminologySection({
  initial,
}: {
  initial: OrganisationSettingsView['terminology'];
}) {
  const [rows, setRows] = useState(() => {
    const entries = Object.entries(initial ?? {});
    if (entries.length === 0) return [{ id: newId(), key: '', label: '' }];
    return entries.map(([key, label]) => ({ id: newId(), key, label }));
  });
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const record: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      const label = row.label.trim();
      if (!key && !label) continue;
      if (!key || !label) {
        setNotice({ tone: 'err', text: 'Each term needs a key and a label.' });
        return;
      }
      if (record[key]) {
        setNotice({ tone: 'err', text: 'Term keys must be unique.' });
        return;
      }
      record[key] = label;
    }
    setPending(true);
    setNotice(null);
    const error = await saveField(
      'terminology',
      Object.keys(record).length > 0 ? record : null,
    );
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section
      id="terminology-heading"
      title="Terminology"
      description="Labels this organisation prefers. Keys are short identifiers such as applicant or council."
    >
      {rows.map((row, index) => (
        <div key={row.id} className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`term-key-${row.id}`}>Key</Label>
            <Input
              id={`term-key-${row.id}`}
              value={row.key}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item) =>
                    item.id === row.id ? { ...item, key: event.target.value } : item,
                  ),
                )
              }
              placeholder={index === 0 ? 'applicant' : ''}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`term-label-${row.id}`}>Label</Label>
            <Input
              id={`term-label-${row.id}`}
              value={row.label}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item) =>
                    item.id === row.id ? { ...item, label: event.target.value } : item,
                  ),
                )
              }
            />
          </div>
        </div>
      ))}
      <div>
        <AddRowButton
          onClick={() =>
            setRows((current) => [...current, { id: newId(), key: '', label: '' }])
          }
        >
          Add term
        </AddRowButton>
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function BrandingSection({ initial }: { initial: OrganisationSettingsView['branding'] }) {
  const [primaryColor, setPrimaryColor] = useState(initial?.primaryColor ?? '');
  const [logoRef, setLogoRef] = useState(initial?.logoRef ?? '');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const color = primaryColor.trim();
    const logo = logoRef.trim();
    const value =
      !color && !logo
        ? null
        : {
            ...(color ? { primaryColor: color } : {}),
            ...(logo ? { logoRef: logo } : {}),
          };
    setPending(true);
    setNotice(null);
    const error = await saveField('branding', value);
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section
      id="branding-heading"
      title="Branding"
      description="The primary colour is used on certificates. Use a hex colour such as #1B4D3E."
    >
      <div className="grid gap-2">
        <Label htmlFor="brand-color">Primary colour</Label>
        <Input
          id="brand-color"
          value={primaryColor}
          onChange={(event) => setPrimaryColor(event.target.value)}
          placeholder="#1B4D3E"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="brand-logo">Logo reference</Label>
        <Input
          id="brand-logo"
          value={logoRef}
          onChange={(event) => setLogoRef(event.target.value)}
          placeholder="Stored file reference, not a public URL"
        />
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function GuidanceSection({
  field,
  title,
  description,
  initial,
}: {
  field: 'publicGuidance' | 'eligibilityGuidance';
  title: string;
  description: string;
  initial: OrganisationSettingsView['publicGuidance'];
}) {
  const [heading, setHeading] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const titleText = heading.trim();
    const bodyText = body.trim();
    if (!bodyText && titleText) {
      setNotice({ tone: 'err', text: 'Add the guidance text.' });
      return;
    }
    const value = bodyText
      ? { body: bodyText, ...(titleText ? { title: titleText } : {}) }
      : null;
    setPending(true);
    setNotice(null);
    const error = await saveField(field, value);
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section id={`${field}-heading`} title={title} description={description}>
      <div className="grid gap-2">
        <Label htmlFor={`${field}-title`}>Title</Label>
        <Input
          id={`${field}-title`}
          value={heading}
          onChange={(event) => setHeading(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${field}-body`}>Text</Label>
        <Textarea
          id={`${field}-body`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function EvidenceSection({
  initial,
}: {
  initial: OrganisationSettingsView['evidenceRequirements'];
}) {
  const [intro, setIntro] = useState(initial?.intro ?? '');
  const [items, setItems] = useState(() =>
    (initial?.items ?? []).map((item) => ({
      id: newId(),
      label: item.label,
      detail: item.detail ?? '',
      required: item.required === true,
    })),
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const cleaned: Array<{ label: string; detail?: string; required?: boolean }> = [];
    for (const item of items) {
      const label = item.label.trim();
      const detail = item.detail.trim();
      if (!label && !detail && !item.required) continue;
      if (!label) {
        setNotice({ tone: 'err', text: 'Each evidence item needs a label.' });
        return;
      }
      cleaned.push({
        label,
        ...(detail ? { detail } : {}),
        ...(item.required ? { required: true } : {}),
      });
    }
    const introText = intro.trim();
    const value =
      cleaned.length === 0 && !introText
        ? null
        : { items: cleaned, ...(introText ? { intro: introText } : {}) };
    setPending(true);
    setNotice(null);
    const error = await saveField('evidenceRequirements', value);
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section
      id="evidence-requirements-heading"
      title="Evidence requirements"
      description="Shown in the case workspace when staff request or upload evidence. This list does not decide an application."
    >
      <div className="grid gap-2">
        <Label htmlFor="evidence-intro">Introduction</Label>
        <Textarea
          id="evidence-intro"
          value={intro}
          onChange={(event) => setIntro(event.target.value)}
          rows={3}
        />
      </div>
      {items.map((item) => (
        <div key={item.id} className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor={`evidence-label-${item.id}`}>Label</Label>
            <Input
              id={`evidence-label-${item.id}`}
              value={item.label}
              onChange={(event) =>
                setItems((current) =>
                  current.map((row) =>
                    row.id === item.id ? { ...row, label: event.target.value } : row,
                  ),
                )
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`evidence-detail-${item.id}`}>Detail</Label>
            <Input
              id={`evidence-detail-${item.id}`}
              value={item.detail}
              onChange={(event) =>
                setItems((current) =>
                  current.map((row) =>
                    row.id === item.id ? { ...row, detail: event.target.value } : row,
                  ),
                )
              }
            />
          </div>
          <label
            className="flex items-center gap-2 text-sm"
            htmlFor={`evidence-asked-${item.id}`}
          >
            <input
              id={`evidence-asked-${item.id}`}
              type="checkbox"
              checked={item.required}
              onChange={(event) =>
                setItems((current) =>
                  current.map((row) =>
                    row.id === item.id ? { ...row, required: event.target.checked } : row,
                  ),
                )
              }
              className="border-input text-primary focus-visible:ring-ring size-5 rounded"
            />
            Asked for
          </label>
        </div>
      ))}
      <div>
        <AddRowButton
          onClick={() =>
            setItems((current) => [
              ...current,
              { id: newId(), label: '', detail: '', required: false },
            ])
          }
        >
          Add item
        </AddRowButton>
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function ConsentSection({
  initial,
}: {
  initial: OrganisationSettingsView['consentWording'];
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [version, setVersion] = useState(initial?.version ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const titleText = title.trim();
    const versionText = version.trim();
    const bodyText = body.trim();
    if (!bodyText && (titleText || versionText)) {
      setNotice({ tone: 'err', text: 'Add the consent wording.' });
      return;
    }
    const value = bodyText
      ? {
          body: bodyText,
          ...(titleText ? { title: titleText } : {}),
          ...(versionText ? { version: versionText } : {}),
        }
      : null;
    setPending(true);
    setNotice(null);
    const error = await saveField('consentWording', value);
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section
      id="consent-heading"
      title="Consent wording"
      description="Shown on public form links before the recipient submits. Saving this text does not record a person's consent."
    >
      <div className="grid gap-2">
        <Label htmlFor="consent-title">Title</Label>
        <Input
          id="consent-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="consent-version">Version</Label>
        <Input
          id="consent-version"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          placeholder="2026-10"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="consent-body">Wording</Label>
        <Textarea
          id="consent-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function RetentionSection({
  initial,
}: {
  initial: OrganisationSettingsView['retentionDefaults'];
}) {
  const [applicationDays, setApplicationDays] = useState(
    initial?.applicationDays?.toString() ?? '',
  );
  const [evidenceDays, setEvidenceDays] = useState(
    initial?.evidenceDays?.toString() ?? '',
  );
  const [decisionDays, setDecisionDays] = useState(
    initial?.decisionDays?.toString() ?? '',
  );
  const [certificateDays, setCertificateDays] = useState(
    initial?.certificateDays?.toString() ?? '',
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  function days(raw: string): number | undefined | null {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (!/^\d+$/.test(trimmed)) return null;
    return Number(trimmed);
  }

  async function onSave() {
    const parsed = {
      applicationDays: days(applicationDays),
      evidenceDays: days(evidenceDays),
      decisionDays: days(decisionDays),
      certificateDays: days(certificateDays),
    };
    if (Object.values(parsed).some((value) => value === null)) {
      setNotice({
        tone: 'err',
        text: 'Retention periods must be whole numbers of days.',
      });
      return;
    }
    const value = {
      ...(parsed.applicationDays !== undefined
        ? { applicationDays: parsed.applicationDays }
        : {}),
      ...(parsed.evidenceDays !== undefined ? { evidenceDays: parsed.evidenceDays } : {}),
      ...(parsed.decisionDays !== undefined ? { decisionDays: parsed.decisionDays } : {}),
      ...(parsed.certificateDays !== undefined
        ? { certificateDays: parsed.certificateDays }
        : {}),
    };
    setPending(true);
    setNotice(null);
    const error = await saveField(
      'retentionDefaults',
      Object.keys(value).length > 0 ? value : null,
    );
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  const fields = [
    ['retention-application', 'Application days', applicationDays, setApplicationDays],
    ['retention-evidence', 'Evidence days', evidenceDays, setEvidenceDays],
    ['retention-decision', 'Decision days', decisionDays, setDecisionDays],
    ['retention-certificate', 'Certificate days', certificateDays, setCertificateDays],
  ] as const;

  return (
    <Section
      id="retention-heading"
      title="Retention defaults"
      description="Numbers this organisation wants on record. They do not themselves delete or keep any record."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([id, label, value, setValue]) => (
          <div key={id} className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        ))}
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function ContactsSection({
  initial,
}: {
  initial: OrganisationSettingsView['escalationContacts'];
}) {
  const [contacts, setContacts] = useState(() =>
    (initial?.contacts ?? []).map((contact) => ({
      id: newId(),
      role: contact.role,
      name: contact.name ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
    })),
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function onSave() {
    const cleaned: Array<{
      role: string;
      name?: string;
      email?: string;
      phone?: string;
    }> = [];
    for (const contact of contacts) {
      const role = contact.role.trim();
      const name = contact.name.trim();
      const email = contact.email.trim();
      const phone = contact.phone.trim();
      if (!role && !name && !email && !phone) continue;
      if (!role || (!name && !email && !phone)) {
        setNotice({
          tone: 'err',
          text: 'Each contact needs a role and a name, email or phone.',
        });
        return;
      }
      cleaned.push({
        role,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      });
    }
    setPending(true);
    setNotice(null);
    const error = await saveField(
      'escalationContacts',
      cleaned.length > 0 ? { contacts: cleaned } : null,
    );
    setPending(false);
    setNotice(error ? { tone: 'err', text: error } : { tone: 'ok', text: 'Saved.' });
  }

  return (
    <Section
      id="contacts-heading"
      title="Escalation contacts"
      description="Safeguarding contacts for staff. Names, emails and phones are stored here and are left out of the audit trail."
    >
      {contacts.map((contact) => (
        <div key={contact.id} className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['role', 'Role', contact.role],
              ['name', 'Name', contact.name],
              ['email', 'Email', contact.email],
              ['phone', 'Phone', contact.phone],
            ] as const
          ).map(([key, label, value]) => (
            <div key={key} className="grid gap-2">
              <Label htmlFor={`contact-${key}-${contact.id}`}>{label}</Label>
              <Input
                id={`contact-${key}-${contact.id}`}
                type={key === 'email' ? 'email' : 'text'}
                value={value}
                onChange={(event) =>
                  setContacts((current) =>
                    current.map((row) =>
                      row.id === contact.id ? { ...row, [key]: event.target.value } : row,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
      ))}
      <div>
        <AddRowButton
          onClick={() =>
            setContacts((current) => [
              ...current,
              { id: newId(), role: '', name: '', email: '', phone: '' },
            ])
          }
        >
          Add contact
        </AddRowButton>
      </div>
      <SaveBar pending={pending} notice={notice} onSave={onSave} />
    </Section>
  );
}

function ChecklistSection({ initial }: { initial: ReadinessChecklistView | null }) {
  const hydrated = useHydrated();
  const [items, setItems] = useState(initial?.items ?? []);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function record(item: string, complete: boolean) {
    setPending(item);
    setNotice(null);
    try {
      const response = await fetch('/api/organisation/readiness', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, complete }),
      });
      if (!response.ok) {
        setNotice({
          tone: 'err',
          text:
            response.status === 403
              ? 'No permission for that action.'
              : 'Could not record that item. Try again.',
        });
        return;
      }
      const body = (await response.json()) as { checklist: ReadinessChecklistView };
      setItems(body.checklist.items);
      setNotice({ tone: 'ok', text: 'Recorded.' });
    } catch {
      setNotice({ tone: 'err', text: 'Could not record that item. Try again.' });
    } finally {
      setPending(null);
    }
  }

  return (
    <Section
      id="readiness-heading"
      title="Readiness checklist"
      description="A person records each onboarding item. Nothing here is ticked automatically, and nothing here decides an application."
    >
      {initial === null ? (
        <p className="text-muted-foreground text-sm">
          The stored checklist could not be read. Ask the platform operator to record it
          again.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key}>
              <label
                className="flex items-start gap-2 text-sm"
                htmlFor={`ready-${item.key}`}
              >
                <input
                  id={`ready-${item.key}`}
                  type="checkbox"
                  checked={item.complete}
                  disabled={!hydrated || pending !== null}
                  onChange={(event) => record(item.key, event.target.checked)}
                  className="border-input text-primary focus-visible:ring-ring mt-0.5 size-5 rounded"
                />
                {item.label}
              </label>
            </li>
          ))}
        </ul>
      )}
      <NoticeLine notice={notice} />
    </Section>
  );
}

/** Admin editor for organisation settings and domain verification. */
export function OrganisationSettingsEditor({
  initialSettings,
  initialDomains,
  initialChecklist,
}: {
  initialSettings: OrganisationSettingsView;
  initialDomains: OrganisationDomainView[];
  /** From onboarding readiness; null when the stored checklist is unreadable. */
  initialChecklist: ReadinessChecklistView | null;
}) {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Organisation settings</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Wording, branding and domains for this organisation. Each save is audited
          without personal contact details or the full text of guidance.
        </p>
      </header>
      <Alert tone="info" title="Guidance only">
        These settings never score, rank, predict, approve or reject Aboriginality.
        Outcomes stay human decisions.
      </Alert>
      <TerminologySection initial={initialSettings.terminology} />
      <BrandingSection initial={initialSettings.branding} />
      <GuidanceSection
        field="publicGuidance"
        title="Public guidance"
        description="Staff reference for how the organisation explains the process. It is not published on the public form."
        initial={initialSettings.publicGuidance}
      />
      <GuidanceSection
        field="eligibilityGuidance"
        title="Eligibility guidance"
        description="Informational wording for staff. It is not applied as a rule and never determines Aboriginality."
        initial={initialSettings.eligibilityGuidance}
      />
      <EvidenceSection initial={initialSettings.evidenceRequirements} />
      <ConsentSection initial={initialSettings.consentWording} />
      <RetentionSection initial={initialSettings.retentionDefaults} />
      <ContactsSection initial={initialSettings.escalationContacts} />
      <ChecklistSection initial={initialChecklist} />
      <OrganisationDomainsPanel initialDomains={initialDomains} />
    </div>
  );
}
