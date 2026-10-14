// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormBuilder } from '@/components/forms/form-builder';
import { FormStatusControls } from '@/components/forms/form-status-controls';
import { NewFormButton } from '@/components/forms/new-form-button';

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

beforeEach(() => {
  navigation.refresh.mockClear();
  navigation.push.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('form status controls', () => {
  it('publishes a draft and closes a published form', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const { unmount } = render(<FormStatusControls formId="form-1" status="draft" />);
    expect(screen.queryByRole('button', { name: 'Close form' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/forms/form-1/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'published' }),
      }),
    );
    expect(navigation.refresh).toHaveBeenCalled();
    unmount();

    render(<FormStatusControls formId="form-1" status="published" />);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close form' }));
    await screen.findByRole('button', { name: 'Close form' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/forms/form-1/status',
      expect.objectContaining({ body: JSON.stringify({ status: 'closed' }) }),
    );
  });

  it('shows an error when the status update fails', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    render(<FormStatusControls formId="form-1" status="draft" />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Could not update the form status'),
    );
  });
});

describe('form builder', () => {
  it('adds a field and saves the title the author typed', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    render(
      <FormBuilder
        formId="form-1"
        initialTitle="Intake questions"
        initialDescription={null}
        initialFields={[]}
      />,
    );

    expect(screen.getByText(/no fields yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(document.querySelector('input[value="Short text"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body)) as {
      title: string;
      fields: { label: string }[];
    };
    expect(body.title).toBe('Intake questions');
    expect(body.fields[0]?.label).toBe('Short text');
  });

  it('refuses to save a form with no title', () => {
    render(
      <FormBuilder
        formId="form-1"
        initialTitle=""
        initialDescription={null}
        initialFields={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toMatch(/needs a title/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('new form button', () => {
  it('asks for a title, then opens the new form', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewFormButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a form' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert').textContent).toMatch(/needs a title/);

    fireEvent.change(screen.getByLabelText(/form title/i), {
      target: { value: '  Family history  ' },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ form: { id: 'form-9' } }), { status: 200 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await vi.waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith('/forms/form-9');
    });
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      title: string;
    };
    expect(body.title).toBe('Family history');
  });
});
