import { cn } from './cn'

/**
 * Loading placeholder shaped like the content it replaces.
 *
 * Preferred over a spinner because it doesn't move the layout when data lands.
 * The shimmer is decorative, so it's hidden from assistive tech - the live
 * region in AsyncBoundary announces loading instead.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'bg-panel-2 animate-shimmer rounded-md',
        'bg-[linear-gradient(90deg,var(--color-panel-2)_0%,var(--color-line)_50%,var(--color-panel-2)_100%)] bg-[length:200%_100%]',
        className,
      )}
    />
  )
}

/** Rows of skeleton lines, for list and table screens. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === rows - 1 ? 'w-1/2' : 'w-full')} />
      ))}
    </div>
  )
}
