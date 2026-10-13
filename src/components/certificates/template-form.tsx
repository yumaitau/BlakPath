'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Publish the organisation's certificate template.
 *
 * Each save that changes wording, signatory or logo stores a new version.
 * Existing signed certificates keep the PDF they were issued with.
 */

export interface TemplateFormInitial {
  version: number;
  wording: string;
  signatoryName: string;
  signatoryRole: string;
  hasLogo: boolean;
}

const LOGO_LIMIT = 512 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function CertificateTemplateForm({
  initial,
}: {
  initial: TemplateFormInitial | null;
}) {
  const router = useRouter();
  const [wording, setWording] = useState(initial?.wording ?? '');
  const [signatoryName, setSignatoryName] = useState(initial?.signatoryName ?? '');
  const [signatoryRole, setSignatoryRole] = useState(initial?.signatoryRole ?? '');
  const [clearLogo, setClearLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData(event.currentTarget);
      const file = form.get('logo');
      let logoBase64: string | undefined;
      if (file instanceof File && file.size > 0) {
        if (file.size > LOGO_LIMIT) {
          setError('Logo must be a PNG or JPEG under 512 KB.');
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        logoBase64 = bytesToBase64(bytes);
      }
      const res = await fetch('/api/settings/certificate-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wording,
          signatoryName,
          signatoryRole,
          ...(logoBase64 ? { logoBase64 } : {}),
          ...(clearLogo && !logoBase64 ? { clearLogo: true } : {}),
        }),
      });
      const data: {
        error?: string;
        unchanged?: boolean;
        template?: { version: number };
      } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'The template could not be published.');
        return;
      }
      setNotice(
        data.unchanged
          ? `Version ${data.template?.version ?? initial?.version ?? ''} is already current.`
          : `Published version ${data.template?.version ?? ''}.`,
      );
      setClearLogo(false);
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="mt-8 flex flex-col gap-5">
      {error ? (
        <Alert tone="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Field
        id="certificate-wording"
        label="Certificate wording"
        description="Printed above the person's name. This records your organisation's words. It does not decide an application."
        required
      >
        {(props) => (
          <Textarea
            {...props}
            rows={6}
            value={wording}
            onChange={(event) => setWording(event.target.value)}
          />
        )}
      </Field>

      <Field id="signatory-name" label="Signatory name" required>
        {(props) => (
          <Input
            {...props}
            value={signatoryName}
            onChange={(event) => setSignatoryName(event.target.value)}
            autoComplete="name"
          />
        )}
      </Field>

      <Field
        id="signatory-role"
        label="Signatory role"
        description="For example, Chairperson. The person who later signs in BlakPath still has to hold permission to sign."
        required
      >
        {(props) => (
          <Input
            {...props}
            value={signatoryRole}
            onChange={(event) => setSignatoryRole(event.target.value)}
          />
        )}
      </Field>

      <Field
        id="certificate-logo"
        label="Logo"
        description={
          initial?.hasLogo
            ? 'PNG or JPEG, up to 512 KB. Leave empty to keep the current logo.'
            : 'Optional PNG or JPEG, up to 512 KB.'
        }
      >
        {(props) => (
          <Input
            {...props}
            name="logo"
            type="file"
            accept="image/png,image/jpeg"
            required={false}
          />
        )}
      </Field>

      {initial?.hasLogo ? (
        <label className="flex items-center gap-2 text-sm" htmlFor="clear-logo">
          <input
            id="clear-logo"
            type="checkbox"
            checked={clearLogo}
            onChange={(event) => setClearLogo(event.target.checked)}
          />
          Remove the current logo
        </label>
      ) : null}

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Publishing…' : 'Publish template'}
        </Button>
      </div>
    </form>
  );
}
