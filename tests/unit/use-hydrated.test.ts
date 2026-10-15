// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { useHydrated } from '@/lib/hooks/use-hydrated';

function Probe() {
  return createElement('button', { disabled: !useHydrated() }, 'Act');
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useHydrated', () => {
  it('is false in the server render', () => {
    expect(renderToString(createElement(Probe))).toContain('disabled');
  });

  it('turns true once the server markup is hydrated', async () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(createElement(Probe));
    document.body.append(container);
    expect(container.querySelector('button')?.disabled).toBe(true);

    await act(async () => {
      hydrateRoot(container, createElement(Probe));
    });
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it('is true straight away for a client-only render', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(createElement(Probe));
    });
    expect(container.querySelector('button')?.disabled).toBe(false);
  });
});
