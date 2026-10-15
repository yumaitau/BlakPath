/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FamilyLinksPanel,
  type FamilyLinksPanelProps,
} from '@/components/applications/family-links-panel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const deceasedName = 'Aunty May of the Example family';

function props(overrides: Partial<FamilyLinksPanelProps> = {}): FamilyLinksPanelProps {
  return {
    applicationId: 'app-1',
    currentUserId: 'genealogy-b',
    deceasedWarning: 'Pause before this name. It belongs to someone who has passed.',
    links: [
      {
        id: 'link-1',
        relationship: 'grandmother',
        relativeName: deceasedName,
        community: 'Example Nation',
        notes: 'Maternal line.',
        relativeDeceased: true,
        status: 'requested',
        requestedByUserId: 'genealogy-a',
        decisionNote: null,
        createdAt: '2026-10-13T00:00:00.000Z',
      },
    ],
    permissions: { request: true, approve: true },
    ...overrides,
  };
}

function focusable(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    ),
  ];
}

/** Move focus the way Tab would, across the panel's native controls. */
function pressTab(root: ParentNode, shift = false): HTMLElement | null {
  const nodes = focusable(root);
  const index = nodes.indexOf(document.activeElement as HTMLElement);
  const next =
    nodes[shift ? Math.max(index - 1, 0) : Math.min(index + 1, nodes.length - 1)];
  next?.focus();
  return next ?? null;
}

/**
 * Browsers turn Enter or Space on a focused button into a click. jsdom does
 * not, so the test dispatches both and requires the target to be a button.
 */
function activate(el: HTMLElement): void {
  if (el.tagName !== 'BUTTON') throw new Error(`expected a button, got ${el.tagName}`);
  fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' });
  fireEvent.click(el);
}

describe('family links panel', () => {
  it('passes axe and keeps a deceased name hidden until keyboard reveal', async () => {
    document.documentElement.lang = 'en';
    const { container } = render(<FamilyLinksPanel {...props()} />);

    expect(container.textContent).not.toContain(deceasedName);
    expect(container.textContent).not.toContain('Example Nation');
    expect(screen.getByText(/Pause before this name/)).toBeTruthy();

    const violations = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    expect(violations.violations).toEqual([]);

    const show = screen.getByRole('button', {
      name: 'Show recorded name for grandmother',
    });
    show.focus();
    expect(document.activeElement).toBe(show);
    activate(show);

    expect(container.textContent).toContain(deceasedName);
    expect(container.textContent).toContain('Example Nation');
    expect(document.activeElement?.textContent).toContain(deceasedName);

    const controls = focusable(container);
    controls[0]?.focus();
    const seen = new Set<HTMLElement>([document.activeElement as HTMLElement]);
    for (let i = 0; i < controls.length; i += 1) pressTab(container);
    for (const control of controls) {
      control.focus();
      seen.add(control);
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
      if (
        control.tagName === 'BUTTON' ||
        control.tagName === 'INPUT' ||
        control.tagName === 'TEXTAREA'
      ) {
        expect(
          control.getAttribute('aria-label') ||
            control.textContent ||
            control.getAttribute('id'),
        ).toBeTruthy();
      }
    }
    expect(seen.size).toBe(controls.length);
  });

  it('offers record to the requester and approve only to someone else', () => {
    const { rerender } = render(
      <FamilyLinksPanel {...props({ currentUserId: 'genealogy-a' })} />,
    );
    expect(screen.getByRole('button', { name: 'Record family link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve link' })).toBeNull();
    expect(screen.getByText(/Someone else must approve or dispute/)).toBeTruthy();

    rerender(<FamilyLinksPanel {...props({ currentUserId: 'genealogy-b' })} />);
    expect(screen.getByRole('button', { name: 'Approve link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dispute link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw link' })).toBeNull();
  });

  it('submits a recorded link from the keyboard', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ link: { id: 'link-2' } }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FamilyLinksPanel {...props({ links: [], currentUserId: 'genealogy-a' })} />);

    fireEvent.change(screen.getByLabelText(/Relationship/), {
      target: { value: 'uncle' },
    });
    fireEvent.change(screen.getByLabelText(/Relative's name/), {
      target: { value: 'Uncle Joe' },
    });
    fireEvent.click(screen.getByLabelText('Relative is deceased'));
    const submit = screen.getByRole('button', { name: 'Record family link' });
    submit.focus();
    await act(async () => {
      activate(submit);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    if (!call?.[1]) throw new Error('record request was not sent');
    const [url, init] = call;
    expect(url).toBe('/api/applications/app-1/family-links');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      relationship: 'uncle',
      relativeName: 'Uncle Joe',
      relativeDeceased: true,
    });
    vi.unstubAllGlobals();
  });
});
