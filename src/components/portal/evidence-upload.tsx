'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Send a file for one application. Bytes go to quarantine through the existing
 * evidence API. The portal does not decide whether the file answers a request.
 * Staff record that later.
 */
export function EvidenceUpload({
  applicationId,
  fulfilsRequestId,
  inputId,
  label,
}: {
  applicationId: string;
  fulfilsRequestId?: string;
  inputId: string;
  label: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const request = await fetch(`/api/applications/${applicationId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          ...(fulfilsRequestId ? { fulfilsRequestId } : {}),
        }),
      });
      if (!request.ok) {
        setError(
          'That file could not be prepared. Check the type and size, then try again.',
        );
        return;
      }
      const prepared = (await request.json()) as {
        evidence: { id: string };
        upload: { url: string; headers: Record<string, string> };
      };
      const uploaded = await fetch(prepared.upload.url, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
          ...prepared.upload.headers,
        },
        body: file,
      });
      if (!uploaded.ok) {
        setError('The file did not send. You can try again.');
        return;
      }
      // The cookie-mutation guard only accepts JSON bodies on /api mutations.
      const completed = await fetch(`/api/evidence/${prepared.evidence.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!completed.ok) {
        setError(
          'The file arrived, but the safety check could not be started. Try again later.',
        );
        return;
      }
      setFile(null);
      setMessage(
        'Your file has been sent. It is checked for safety before the organisation can open it.',
      );
      router.refresh();
    } catch {
      setError('The file could not be sent. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3">
      {error ? (
        <Alert tone="destructive" role="alert" title="The file was not sent">
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" role="status" title="File sent">
          {message}
        </Alert>
      ) : null}
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        className="mt-2"
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/tiff,image/heic,image/heif,.doc,.docx"
        required
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <p className="text-muted-foreground mt-2 text-sm">
        PDF, JPEG, PNG, TIFF, HEIC or Word. Up to 25 MB.
      </p>
      <Button className="mt-3" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Upload evidence'}
      </Button>
    </form>
  );
}
