import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'
type Shape = 'control' | 'pill'

/**
 * Primary is the design's blue-to-cyan gradient with a white, bold label. On a
 * page of translucent glass it is the only saturated surface, which is what
 * makes it read as "press this" from across a room.
 *
 * The label is white rather than near-black: this blue is dark enough that
 * dark text on it would leave the primary action as the least readable thing
 * on the screen. See --gradient-accent in index.css for why the gradient's
 * ANGLE is load-bearing rather than decorative - it keeps the light cyan end
 * in a corner instead of under the text.
 *
 * Secondary is glass, one step denser than the cards. Against translucent
 * surfaces an outlined button reads as a gap rather than a control, so it
 * borrows the card treatment instead of drawing a border. Two visually
 * competing button styles side by side is the most common way a toolbar ends
 * up looking generated: everything shouts, so nothing leads.
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent font-medium hover:brightness-110 active:brightness-95',
  /* Secondary is glass rather than a ring on nothing. Against translucent
     cards a bare outlined button reads as a gap in the surface; the same
     treatment as the cards, one step denser, reads as a control resting on
     them. */
  secondary: 'text-ink bg-panel-2 border-line hover:border-line-strong hover:bg-line/60 border',
  ghost: 'text-ink-2 hover:surface-glass-2 hover:text-ink',
  danger: 'text-danger ring-danger/40 hover:bg-danger/12 ring-1',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9.5 px-4 text-sm',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** `pill` for filter and range controls, which read as settings not actions. */
  shape?: Shape
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  shape = 'control',
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      // Default to "button": an unset type inside a form submits it, which on
      // this dashboard could mean firing a hardware command by accident.
      type={type}
      className={cn(
        'ease-soft inline-flex items-center justify-center gap-2 transition-all duration-150',
        shape === 'pill' ? 'rounded-pill' : 'rounded-control',
        /* A press should be felt. One frame of scale is below the threshold of
           looking like an animation and above the threshold of feeling dead. */
        'active:scale-[0.985]',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * The small round control in a panel header - "there is more behind this card".
 *
 * Square-ish would be wrong here. A circle at this size reads as a marker
 * rather than as a miniature button, which is what keeps eight of them across a
 * dashboard from looking like a toolbar that escaped.
 *
 * `label` is required rather than optional because this never contains text,
 * and an icon-only control with no accessible name is invisible to anyone not
 * looking at it.
 */
export function IconButton({
  label,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'text-ink-3 ring-line/70 hover:text-ink hover:bg-panel-2 hover:ring-line-strong ease-soft grid size-7 place-items-center rounded-full ring-1 transition-all duration-150 active:scale-95',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
