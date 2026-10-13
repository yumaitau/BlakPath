// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationCaseWorkspace } from '@/components/applications/application-case-workspace';

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

const permissions = {
  updateIntake: true,
  assign: true,
  requestEvidence: true,
  downloadEvidence: true,
  addNote: true,
  uploadEvidence: true,
};

function workspace(
  overrides: Partial<Parameters<typeof ApplicationCaseWorkspace>[0]> = {},
) {
  return (
    <ApplicationCaseWorkspace
      applicationId="app-1"
      applicantName="Ada Jones"
      priority="normal"
      status="in_review"
      assignedToCurrentUser={false}
      availableActions={[{ value: 'submit_for_review', label: 'Submit for review' }]}
      evidence={[
        {
          id: 'ev-clean',
          fileName: 'birth-record.pdf',
          status: 'clean',
          classification: 'supplied',
          sizeBytes: 2048,
          createdAt: '2026-10-01T01:00:00.000Z',
        },
        {
          id: 'ev-bad',
          fileName: 'scan.png',
          status: 'infected',
          classification: null,
          sizeBytes: 1024,
          createdAt: '2026-10-01T01:00:00.000Z',
        },
      ]}
      evidenceRequests={[]}
      history={[
        {
          id: 'hist-1',
          action: 'transition',
          toStatus: 'in_review',
          note: 'Received at the counter',
          createdAt: '2026-10-01T01:00:00.000Z',
        },
      ]}
      notes={[]}
      permissions={permissions}
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

describe('application case workspace', () => {
  it('shows supplied details, a human stage, and only a clean download', () => {
    render(workspace());

    expect(screen.getByLabelText('Name as provided')).toHaveProperty(
      'value',
      'Ada Jones',
    );
    expect(screen.getByText(/do not assess or determine Aboriginality/i)).toBeTruthy();
    expect(screen.getAllByText('In Review').length).toBeGreaterThan(0);
    expect(screen.getByText('birth-record.pdf')).toBeTruthy();
    expect(screen.getByText('Scan clean')).toBeTruthy();
    expect(screen.getByText('Infected')).toBeTruthy();
    expect(screen.getByRole('link', { name: /download/i }).getAttribute('href')).toBe(
      '/api/evidence/ev-clean/download',
    );
    expect(screen.getAllByRole('link', { name: /download/i })).toHaveLength(1);
  });

  it('hides intake editing when the person cannot update intake', () => {
    render(workspace({ permissions: { ...permissions, updateIntake: false } }));
    expect(screen.queryByLabelText('Name as provided')).toBeNull();
    expect(screen.getByText('Ada Jones')).toBeTruthy();
  });

  it('saves intake as a human edit and reports a permission refusal', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    render(workspace());

    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Intake details saved.')).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/applications/app-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          operation: 'update_intake',
          applicantName: 'Ada Jones',
          priority: 'normal',
        }),
      }),
    );
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it('records the next step the person chose', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    render(workspace());

    fireEvent.click(screen.getByRole('button', { name: 'Record next step' }));
    expect(await screen.findByText('Case stage updated.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/applications/app-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          operation: 'transition',
          action: 'submit_for_review',
        }),
      }),
    );
  });
});
