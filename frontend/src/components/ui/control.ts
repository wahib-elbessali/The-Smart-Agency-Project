import { cn } from './cn'

/**
 * The styling of a form control, separated from Field's label/hint/error
 * wiring.
 *
 * In its own module rather than exported from Field.tsx for the reason the lint
 * rule gives: a file that exports both a component and a plain function breaks
 * Fast Refresh, so editing this string would stop hot-reloading every form that
 * uses it. `cn.ts` sits here for the same reason.
 *
 * Repeatable rows are what need it - a list of counters wants inputs that match
 * every other input on the dashboard but does NOT want a label, hint and error
 * slot above each one. Without this they get a hand-copied class string that
 * drifts the first time the focus ring changes.
 */
export function controlClass(invalid?: boolean): string {
  return cn(
    /* Inset rather than outlined: the field is a well cut into the surface,
       which is why it reads as somewhere to type. The inner shadow is doing
       the work a border used to. */
    'rounded-control bg-canvas/60 text-ink placeholder:text-ink-3 ease-soft w-full px-3 py-2 text-sm ring-1 transition-all duration-150',
    'shadow-[var(--shadow-control-inset)]',
    invalid
      ? 'ring-danger/50 focus:ring-danger'
      : 'ring-line-control focus:ring-accent focus:bg-canvas/80',
  )
}
