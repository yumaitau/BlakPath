'use client';

import { CheckCircle2, CircleDot, LockKeyhole, Vote } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface GovernanceReview {
  id: string;
  status: string;
  content: string;
  createdAt: string;
}

interface GovernanceDecision {
  id: string;
  status: string;
  proposedOutcome: string;
  finalOutcome: string | null;
  rationale: string | null;
  currentUserVote: string | null;
  tally: { for: number; against: number; abstain: number; total: number };
}

interface GovernancePermissions {
  createReview: boolean;
  finaliseReview: boolean;
  proposeDecision: boolean;
  vote: boolean;
  finaliseDecision: boolean;
}

export interface CaseGovernanceWorkspaceProps {
  applicationId: string;
  applicationStatus: string;
  reviews: GovernanceReview[];
  decisions: GovernanceDecision[];
  permissions: GovernancePermissions;
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const outcomeOptions = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'not_confirmed', label: 'Not confirmed' },
  { value: 'deferred', label: 'Deferred' },
] as const;

export function CaseGovernanceWorkspace({
  applicationId,
  applicationStatus,
  reviews,
  decisions,
  permissions,
}: CaseGovernanceWorkspaceProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewContent, setReviewContent] = useState('');
  const [proposedOutcome, setProposedOutcome] = useState('deferred');
  const [rationale, setRationale] = useState('');
  const [voteChoice, setVoteChoice] = useState('abstain');
  const [voteNote, setVoteNote] = useState('');
  const [finalOutcome, setFinalOutcome] = useState('deferred');
  const [finalNote, setFinalNote] = useState('');

  async function send(
    key: string,
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    success: string,
  ): Promise<boolean> {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'Your role does not allow that action, or the record is no longer available.'
            : 'That record could not be saved. Refresh the case and try again.',
        );
        return false;
      }
      setMessage(success);
      router.refresh();
      return true;
    } catch {
      setError('That record could not be saved. Check your connection and try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  const canCreateReview =
    permissions.createReview &&
    ['in_review', 'ready_for_committee'].includes(applicationStatus);
  const canProposeDecision =
    permissions.proposeDecision &&
    ['ready_for_committee', 'in_committee'].includes(applicationStatus) &&
    !decisions.some((decision) => decision.status === 'proposed');

  return (
    <section
      aria-labelledby="human-record-heading"
      className="border-border border-t pt-8"
    >
      <div className="max-w-3xl">
        <p className="text-muted-foreground text-sm font-medium">Human authority</p>
        <h2 id="human-record-heading" className="mt-1 text-xl font-semibold">
          Reviews and committee record
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          BlakPath stores observations, votes and outcomes entered by authorised people.
          It does not recommend, calculate or make a determination.
        </p>
      </div>

      {error ? (
        <Alert className="mt-5" role="alert" tone="destructive" title="Record not saved">
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert className="mt-5" tone="success">
          {message}
        </Alert>
      ) : null}

      <div className="mt-8 grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="reviews-heading">
          <h3 id="reviews-heading" className="text-lg font-semibold">
            Staff reviews
          </h3>
          {reviews.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">
              No review has been recorded. Once the case reaches review, an authorised
              worker can add their observations for the committee.
            </p>
          ) : (
            <ul className="divide-border mt-3 divide-y">
              {reviews.map((review) => (
                <li key={review.id} className="py-4 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <Badge
                      tone={review.status === 'finalised' ? 'success' : 'warning'}
                      icon={review.status === 'finalised' ? LockKeyhole : CircleDot}
                    >
                      {label(review.status)}
                    </Badge>
                    {permissions.finaliseReview ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                          void send(
                            `review:${review.id}`,
                            `/api/reviews/${review.id}`,
                            'PATCH',
                            {
                              operation:
                                review.status === 'finalised' ? 'reopen' : 'finalise',
                            },
                            review.status === 'finalised'
                              ? 'Review reopened for further work.'
                              : 'Review finalised for the committee record.',
                          )
                        }
                      >
                        {busy === `review:${review.id}`
                          ? 'Saving…'
                          : review.status === 'finalised'
                            ? 'Reopen review'
                            : 'Finalise review'}
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm whitespace-pre-wrap">{review.content}</p>
                </li>
              ))}
            </ul>
          )}

          {canCreateReview ? (
            <form
              className="border-border mt-6 border-t pt-5"
              onSubmit={async (event) => {
                event.preventDefault();
                const saved = await send(
                  'create-review',
                  `/api/applications/${applicationId}/reviews`,
                  'POST',
                  { content: reviewContent },
                  'Draft review recorded.',
                );
                if (saved) setReviewContent('');
              }}
            >
              <Label htmlFor="review-observations">Reviewer observations</Label>
              <Textarea
                id="review-observations"
                className="mt-2"
                value={reviewContent}
                onChange={(event) => setReviewContent(event.target.value)}
                maxLength={20000}
                required
              />
              <Button className="mt-3" type="submit" disabled={busy !== null}>
                {busy === 'create-review' ? 'Recording…' : 'Record draft review'}
              </Button>
            </form>
          ) : null}
        </section>

        <section aria-labelledby="committee-heading">
          <h3 id="committee-heading" className="text-lg font-semibold">
            Committee decisions
          </h3>
          {decisions.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">
              No decision has been proposed. Decision controls become available when the
              case is recorded as being in committee.
            </p>
          ) : (
            <ul className="divide-border mt-3 divide-y">
              {decisions.map((decision) => (
                <li key={decision.id} className="py-4 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge
                      tone={decision.status === 'finalised' ? 'success' : 'info'}
                      icon={decision.status === 'finalised' ? CheckCircle2 : Vote}
                    >
                      {label(decision.status)}
                    </Badge>
                    <span className="text-sm font-semibold">
                      {label(decision.finalOutcome ?? decision.proposedOutcome)}
                    </span>
                  </div>
                  {decision.rationale ? (
                    <p className="mt-3 text-sm whitespace-pre-wrap">
                      {decision.rationale}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground mt-3 text-xs">
                    Recorded votes: {decision.tally.for} for, {decision.tally.against}{' '}
                    against, {decision.tally.abstain} abstained. This tally does not
                    decide the outcome.
                  </p>

                  {decision.status === 'proposed' && permissions.vote ? (
                    <form
                      className="mt-4 grid gap-3"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        await send(
                          `vote:${decision.id}`,
                          `/api/decisions/${decision.id}`,
                          'PATCH',
                          {
                            operation: 'vote',
                            choice: voteChoice,
                            note: voteNote || undefined,
                          },
                          decision.currentUserVote
                            ? 'Your vote was changed.'
                            : 'Your vote was recorded.',
                        );
                      }}
                    >
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <Label htmlFor={`vote-choice-${decision.id}`}>Your vote</Label>
                          <select
                            id={`vote-choice-${decision.id}`}
                            value={voteChoice}
                            onChange={(event) => setVoteChoice(event.target.value)}
                            className="border-input bg-surface mt-2 h-10 w-full rounded-md border px-3 text-sm"
                          >
                            <option value="for">For</option>
                            <option value="against">Against</option>
                            <option value="abstain">Abstain</option>
                          </select>
                        </div>
                        <div>
                          <Label htmlFor={`vote-note-${decision.id}`}>
                            Vote note (optional)
                          </Label>
                          <Textarea
                            id={`vote-note-${decision.id}`}
                            rows={2}
                            className="mt-2 min-h-10"
                            value={voteNote}
                            onChange={(event) => setVoteNote(event.target.value)}
                            maxLength={2000}
                          />
                        </div>
                      </div>
                      <Button type="submit" variant="outline" disabled={busy !== null}>
                        {busy === `vote:${decision.id}`
                          ? 'Recording…'
                          : decision.currentUserVote
                            ? 'Change my vote'
                            : 'Record my vote'}
                      </Button>
                    </form>
                  ) : null}

                  {decision.status === 'proposed' && permissions.finaliseDecision ? (
                    <form
                      className="border-border mt-5 border-t pt-4"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        await send(
                          `finalise:${decision.id}`,
                          `/api/decisions/${decision.id}`,
                          'PATCH',
                          {
                            operation: 'finalise',
                            outcome: finalOutcome,
                            note: finalNote || undefined,
                          },
                          'The committee outcome was recorded by an authorised person.',
                        );
                      }}
                    >
                      <p className="text-sm font-semibold">
                        Record the committee outcome
                      </p>
                      <div className="mt-3 grid gap-3">
                        <div>
                          <Label htmlFor={`final-outcome-${decision.id}`}>
                            Outcome decided by the committee
                          </Label>
                          <select
                            id={`final-outcome-${decision.id}`}
                            value={finalOutcome}
                            onChange={(event) => setFinalOutcome(event.target.value)}
                            className="border-input bg-surface mt-2 h-10 w-full rounded-md border px-3 text-sm"
                          >
                            {outcomeOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label htmlFor={`final-note-${decision.id}`}>
                            Committee record note (optional)
                          </Label>
                          <Textarea
                            id={`final-note-${decision.id}`}
                            rows={3}
                            className="mt-2"
                            value={finalNote}
                            onChange={(event) => setFinalNote(event.target.value)}
                            maxLength={5000}
                          />
                        </div>
                        <Button type="submit" disabled={busy !== null}>
                          {busy === `finalise:${decision.id}`
                            ? 'Recording…'
                            : 'Record final outcome'}
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canProposeDecision ? (
            <form
              className="border-border mt-6 border-t pt-5"
              onSubmit={async (event) => {
                event.preventDefault();
                const saved = await send(
                  'propose-decision',
                  `/api/applications/${applicationId}/decisions`,
                  'POST',
                  { outcome: proposedOutcome, rationale: rationale || undefined },
                  'Decision proposal recorded for the committee.',
                );
                if (saved) setRationale('');
              }}
            >
              <div className="grid gap-4">
                <div>
                  <Label htmlFor="proposed-outcome">
                    Outcome proposed by a committee member
                  </Label>
                  <select
                    id="proposed-outcome"
                    value={proposedOutcome}
                    onChange={(event) => setProposedOutcome(event.target.value)}
                    className="border-input bg-surface mt-2 h-10 w-full rounded-md border px-3 text-sm"
                  >
                    {outcomeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="decision-rationale">Rationale (optional)</Label>
                  <Textarea
                    id="decision-rationale"
                    className="mt-2"
                    value={rationale}
                    onChange={(event) => setRationale(event.target.value)}
                    maxLength={5000}
                  />
                </div>
                <Button type="submit" disabled={busy !== null}>
                  {busy === 'propose-decision'
                    ? 'Recording…'
                    : 'Record decision proposal'}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </section>
  );
}
