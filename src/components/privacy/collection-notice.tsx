'use client';

import Link from 'next/link';

import type { CollectionNotice as Notice } from '@/lib/privacy/collection-notice';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * APP 5 collection notice with its acknowledgement control.
 *
 * Shown at every point of collection (public form, applicant evidence upload,
 * staff-led intake). The parent owns the `acknowledged` state, blocks submit
 * until it is true, and posts `{ version, hash }` from `notice` so the server
 * can confirm the exact wording that was shown.
 *
 *   - `self`: the person providing information acknowledges it themselves.
 *   - `staff_attested`: a staff member confirms they gave the notice to the
 *     applicant during intake.
 */
export function CollectionNotice({
  notice,
  id,
  acknowledged,
  onAcknowledgedChange,
  invalid = false,
  mode = 'self',
  collapsible = false,
  headingLevel = 3,
  className,
}: {
  notice: Notice;
  /** Id for the acknowledgement checkbox (focus target on validation error). */
  id: string;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  invalid?: boolean;
  mode?: 'self' | 'staff_attested';
  /** Fold the wording into a disclosure (for narrow staff panels). */
  collapsible?: boolean;
  /** Match the surrounding outline so heading levels never skip. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const Heading = (['h2', 'h3', 'h4'] as const)[headingLevel - 2] ?? 'h3';
  const headingId = `${id}-heading`;
  const errorId = `${id}-error`;
  const label =
    mode === 'self'
      ? 'I have read this collection notice'
      : 'I have given this collection notice to the applicant';

  const body = (
    <div className="text-muted-foreground flex flex-col gap-3 text-sm leading-6">
      {notice.draft ? (
        <p className="text-foreground text-xs font-medium">
          Draft wording pending legal review.
        </p>
      ) : null}
      {notice.paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
      <ContactDetails notice={notice} />
      <p>
        Read the{' '}
        <Link href="/privacy" className="text-primary underline underline-offset-4">
          BlakPath privacy policy
        </Link>
        {notice.privacyPolicyUrl ? (
          <>
            {' '}
            and{' '}
            <a
              href={notice.privacyPolicyUrl}
              className="text-primary underline underline-offset-4"
              rel="noopener noreferrer"
              target="_blank"
            >
              {notice.organisationName}’s privacy policy
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        ) : null}
        .
      </p>
    </div>
  );

  return (
    <section
      aria-labelledby={headingId}
      className={cn('border-border rounded-lg border p-4', className)}
    >
      <Heading id={headingId} className="text-foreground text-base font-semibold">
        {notice.title}
      </Heading>
      {collapsible ? (
        <details className="mt-2">
          <summary className="text-primary cursor-pointer text-sm font-medium">
            Read the collection notice
          </summary>
          <div className="mt-3">{body}</div>
        </details>
      ) : (
        <div className="mt-3">{body}</div>
      )}

      <div className="mt-4 flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={acknowledged}
          aria-required
          aria-invalid={invalid || undefined}
          {...(invalid ? { 'aria-describedby': errorId } : {})}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          className="border-input text-primary focus-visible:ring-ring mt-0.5 size-5 rounded"
        />
        <Label htmlFor={id} required className="font-medium">
          {label}
        </Label>
      </div>
      {invalid ? (
        <p id={errorId} className="text-destructive mt-2 text-sm font-medium">
          Please confirm the collection notice before continuing.
        </p>
      ) : null}
    </section>
  );
}

function ContactDetails({ notice }: { notice: Notice }) {
  const contact = notice.contact;
  if (!contact) {
    return (
      <p>
        For privacy questions, contact {notice.organisationName} using the details it gave
        you.
      </p>
    );
  }
  return (
    <div>
      <p className="text-foreground font-medium">
        Privacy contact for {notice.organisationName}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {contact.name ? <li>{contact.name}</li> : null}
        {contact.email ? (
          <li>
            <a
              href={`mailto:${contact.email}`}
              className="text-primary underline underline-offset-4"
            >
              {contact.email}
            </a>
          </li>
        ) : null}
        {contact.phone ? <li>{contact.phone}</li> : null}
      </ul>
    </div>
  );
}
