'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Records the monthly audit review. Posts JSON because cookie-authenticated
 * `/api` mutations must be same-origin `application/json` (`src/proxy.ts`).
 * Structured fields only: the audit chain is immutable and takes no free text.
 */
export function MonthlyReviewForm({ defaultPeriod }: { defaultPeriod: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<'no_findings' | 'findings_raised'>(
    'no_findings',
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    let result = 'error=invalid';
    try {
      const response = await fetch('/api/audit/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: String(data.get('period') ?? ''),
          outcome,
          findingsCount:
            outcome === 'findings_raised' ? Number(data.get('findingsCount') ?? 0) : 0,
        }),
      });
      if (response.ok) result = 'recorded=1';
      else if (response.status === 401) {
        router.push('/sign-in');
        return;
      } else if (response.status === 403) result = 'error=forbidden';
    } catch {
      result = 'error=invalid';
    } finally {
      setSaving(false);
    }
    router.push(`/audit/review?${result}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="review-period" required>
          Month reviewed
        </Label>
        <Input
          id="review-period"
          name="period"
          type="month"
          required
          defaultValue={defaultPeriod}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Outcome</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="outcome"
            value="no_findings"
            checked={outcome === 'no_findings'}
            onChange={() => setOutcome('no_findings')}
          />
          No findings
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="outcome"
            value="findings_raised"
            checked={outcome === 'findings_raised'}
            onChange={() => setOutcome('findings_raised')}
          />
          Findings raised
        </label>
      </fieldset>
      {outcome === 'findings_raised' ? (
        <div className="space-y-1.5">
          <Label htmlFor="review-findings" required>
            Number of findings
          </Label>
          <Input
            id="review-findings"
            name="findingsCount"
            type="number"
            min={1}
            max={1000}
            required
            defaultValue={1}
          />
          <p className="text-muted-foreground text-xs">
            Record follow-up detail in the case or task it concerns, not here.
          </p>
        </div>
      ) : null}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Recording…' : 'Record this review'}
      </Button>
    </form>
  );
}
