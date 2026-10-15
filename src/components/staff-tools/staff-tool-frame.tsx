import type { ReactNode } from 'react';

export const nativeSelectClass =
  'border-input bg-surface h-11 w-full rounded-md border px-3 text-base';

export function formatStaffDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function humanStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Shared heading and explanation for a permission-gated staff screen. */
export function StaffToolFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-2 leading-6">{description}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}

export function ToolUnavailable({ kind }: { kind: 'denied' | 'unavailable' }) {
  return (
    <p className="text-sm">
      {kind === 'denied'
        ? 'Your role does not include this task.'
        : 'Sign in and select an organisation to continue.'}
    </p>
  );
}
