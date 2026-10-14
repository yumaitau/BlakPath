import { cn } from '@/lib/utils';

/**
 * Loading placeholders for staff routes (used by `loading.tsx` files).
 *
 * The region is a polite status announcing "Loading…" once; the shapes are
 * decorative and hidden from assistive technology. Pulsing only runs when the
 * person has not asked for reduced motion.
 */

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-surface-muted rounded-md motion-safe:animate-pulse', className)}
    />
  );
}

export function PageSkeleton({
  label = 'Loading…',
  variant = 'list',
}: {
  label?: string;
  variant?: 'list' | 'cards' | 'detail';
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6"
    >
      <span className="sr-only">{label}</span>
      <SkeletonBlock className="mb-6 h-8 w-56" />
      {variant === 'cards' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonBlock key={index} className="h-32" />
          ))}
        </div>
      ) : variant === 'detail' ? (
        <div className="flex flex-col gap-6">
          <SkeletonBlock className="h-4 w-32" />
          <div className="grid gap-4 lg:grid-cols-3">
            <SkeletonBlock className="h-64 lg:col-span-2" />
            <SkeletonBlock className="h-64" />
          </div>
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-32" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonBlock key={index} className="h-14" />
          ))}
        </div>
      )}
    </div>
  );
}
