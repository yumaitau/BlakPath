'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Records the monthly audit review. Posts JSON because cookie-authenticated
 * `/api` mutations must be same-origin `application/json` (`src/proxy.ts`).
 */
export function MonthlyReviewForm({ defaultPeriod }: { defaultPeriod: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const notes = String(data.get('notes') ?? '').trim();
    setSaving(true);
    let outcome = 'error=invalid';
    try {
      const response = await fetch('/api/audit/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: String(data.get('period') ?? ''),
          ...(notes ? { notes } : {}),
        }),
      });
      if (response.ok) outcome = 'recorded=1';
      else if (response.status === 401) {
        router.push('/sign-in');
        return;
      } else if (response.status === 403) outcome = 'error=forbidden';
    } catch {
      outcome = 'error=invalid';
    } finally {
      setSaving(false);
    }
    router.push(`/audit/review?${outcome}`);
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
      <div className="space-y-1.5">
        <Label htmlFor="review-notes">What you followed up</Label>
        <Textarea
          id="review-notes"
          name="notes"
          maxLength={500}
          placeholder="Optional. No evidence contents or secrets."
        />
      </div>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Recording…' : 'Record this review'}
      </Button>
    </form>
  );
}
