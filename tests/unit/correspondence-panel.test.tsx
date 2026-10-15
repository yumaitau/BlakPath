// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorrespondencePanel } from '@/components/correspondence/correspondence-panel';
import { TemplateEditor } from '@/components/correspondence/template-editor';

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function panel(overrides: Partial<Parameters<typeof CorrespondencePanel>[0]> = {}) {
  return (
    <CorrespondencePanel
      applicationId="app-1"
      allowedKinds={['general', 'evidence_request']}
      canManageTemplates
      letters={[
        {
          id: 'draft-1',
          kind: 'general',
          channel: 'email',
          status: 'draft',
          subject: 'Draft letter',
          body: null,
          emailText: null,
          sentAt: null,
          createdAt: '2026-10-01T01:00:00.000Z',
          recipientEmail: 'jane@example.test',
        },
        {
          id: 'sent-1',
          kind: 'general',
          channel: 'letter',
          status: 'sent',
          subject: 'Sent letter',
          body: 'Dear Jane',
          emailText: 'Open the [secure link]',
          sentAt: '2026-10-02T01:00:00.000Z',
          createdAt: '2026-10-01T01:00:00.000Z',
          recipientEmail: null,
        },
      ]}
      templates={[{ id: 'tpl-1', name: 'General letter', kind: 'general' }]}
      decisions={[]}
      evidenceRequests={[
        {
          id: 'req-1',
          description: 'Birth certificate',
          status: 'open',
          dueAt: '2026-11-01T00:00:00.000Z',
        },
      ]}
      certificates={[]}
      {...overrides}
    />
  );
}

beforeEach(() => {
  navigation.refresh.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CorrespondencePanel', () => {
  it('prepares a draft and shows the preview without sending', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      json(
        {
          item: { id: 'draft-2' },
          preview: {
            subject: 'Preview subject',
            body: 'Preview body',
            email: { subject: 'Update', text: 'Open the secure link' },
          },
        },
        201,
      ),
    );
    render(panel());
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl-1' } });
    fireEvent.change(screen.getByLabelText('Applicant email'), {
      target: { value: ' jane@example.test ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare letter' }));

    expect(await screen.findByText('Preview subject')).toBeTruthy();
    expect(screen.getByText('Open the secure link')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/applications/app-1/correspondence');
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: 'general',
      channel: 'email',
      templateId: 'tpl-1',
      recipientEmail: 'jane@example.test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a draft as its own step and shows a refusal', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      json({ error: 'This letter has already been sent.' }, 409),
    );
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This letter has already been sent.')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/applications/app-1/correspondence/draft-1/send',
    );
  });

  it('notifies an evidence request and refreshes', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ correspondence: {} }, 201));
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Notify applicant' }));
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/applications/app-1/evidence-requests/req-1/notify',
    );
  });

  it('lists sent letters with the PDF link and the redacted email', () => {
    render(panel({ allowedKinds: [] }));
    expect(screen.queryByRole('button', { name: 'Prepare letter' })).toBeNull();
    expect(screen.getByText('Open the [secure link]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('href')).toBe(
      '/api/correspondence/sent-1/letter',
    );
  });
});

describe('TemplateEditor', () => {
  it('creates a template and refreshes', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ template: {} }, 201));
    render(
      <TemplateEditor
        templates={[
          {
            id: 'tpl-1',
            name: 'Outcome',
            kind: 'outcome',
            subjectTemplate: 'Outcome {{application.reference}}',
            bodyTemplate: 'Dear {{applicant.name}}',
            active: true,
          },
        ]}
      />,
    );
    const field = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`missing #${id}`);
      return element;
    };
    fireEvent.change(field('template-name'), { target: { value: 'General' } });
    fireEvent.change(field('template-subject'), { target: { value: 'Hello' } });
    fireEvent.change(field('template-body'), { target: { value: 'Body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/correspondence/templates');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: 'General',
      kind: 'general',
      subjectTemplate: 'Hello',
      bodyTemplate: 'Body',
    });
  });

  it('shows the server refusal when saving an edit fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      json({ error: 'A template with that name already exists.' }, 409),
    );
    render(
      <TemplateEditor
        templates={[
          {
            id: 'tpl-1',
            name: 'Outcome',
            kind: 'outcome',
            subjectTemplate: 'Outcome',
            bodyTemplate: 'Body',
            active: true,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('A template with that name already exists.'),
    ).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/correspondence/templates/tpl-1');
  });
});
