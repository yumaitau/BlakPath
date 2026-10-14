import { expect, type Page } from '@playwright/test';
import axe from 'axe-core';

/**
 * Run the WCAG rules that map to BlakPath's WCAG 2.2 AA commitment.
 *
 * Keep the raw axe targets in the assertion message so a CI failure points to
 * the element that needs attention instead of only naming the rule.
 */
export async function expectNoWcagViolations(page: Page): Promise<void> {
  // Next.js may stream metadata after visible content on slower CI runners.
  await expect(page).toHaveTitle(/\S/);
  await page.evaluate((source) => {
    let nonce = '';
    for (const existing of document.scripts) {
      if (existing.nonce) {
        nonce = existing.nonce;
        break;
      }
    }
    const script = document.createElement('script');
    if (nonce) script.nonce = nonce;
    script.text = source;
    document.head.appendChild(script);
  }, axe.source);
  const violations = await page.evaluate(async () => {
    type Violation = {
      id: string;
      impact: string | null;
      help: string;
      helpUrl: string;
      nodes: Array<{
        failureSummary: string | undefined;
        html: string;
        target: string[];
      }>;
    };

    const runner = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{ violations: Violation[] }>;
        };
      }
    ).axe;

    const result = await runner.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
      },
    });

    return result.violations.map(({ id, impact, help, helpUrl, nodes }) => ({
      id,
      impact,
      help,
      helpUrl,
      nodes: nodes.map(({ failureSummary, html, target }) => ({
        failureSummary,
        html,
        target: target.join(' '),
      })),
    }));
  });

  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

/** Assert that focus remains visible when a keyboard user moves through a page. */
export async function expectVisibleFocus(page: Page): Promise<void> {
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  const indicator = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  expect(
    indicator.outlineStyle !== 'none' ||
      indicator.outlineWidth > 0 ||
      indicator.boxShadow !== 'none',
  ).toBe(true);
}
