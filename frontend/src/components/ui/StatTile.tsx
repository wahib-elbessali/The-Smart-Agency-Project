import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * A single headline number.
 *
 * `tabular` on the value matters more than it looks: without it the digits are
 * proportionally spaced and the number visibly jitters every time it ticks,
 * which on a wall display reads as the panel flickering.
 *
 * LAYOUT IS TWO COLUMNS, not a stack, and that is taken from the design rather
 * than chosen. Label above value on the left, icon chip on the right, and the
 * whole tile only as tall as those two lines. Stacking the icon above the
 * number instead - which is the obvious arrangement - makes each tile twice as
 * tall, and a row of tall tiles pushes the actual content of the screen below
 * the fold on the display this runs on.
 *
 * The icon is a small plain glyph in the corner, not a chip (2026-10-10).
 * Coloured icon tiles beside every number are a stock dashboard-template
 * trait, and they were louder than the numbers they labelled. The glyph keeps
 * the tone colour for ok/warn, so the colour-coding survives.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint?: string
  icon?: ReactNode
  /**
   * Supporting detail under the value - a sparkline, a share, a trend chip.
   * Sits where the eye lands after the number rather than beside it, so the
   * figure is still the first thing read.
   */
  detail?: ReactNode
  tone?: 'neutral' | 'ok' | 'warn'
}) {
  const valueTone = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
  }[tone]

  /* The glyph's colour follows the reading's tone, so "late arrivals" is
     not wearing the same mark as "in the building". */
  const iconTone = {
    neutral: 'text-ink-3',
    ok: 'text-ok',
    warn: 'text-warn',
  }[tone]

  return (
    <div className="rounded-panel surface-glass shadow-panel px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="text-ink-2 block truncate text-[0.8125rem]">{label}</span>
          {/* Big, bold and tight. The design sets these heavy rather than
              light - on a translucent surface a thin numeral loses its edges
              against whatever is showing through behind it. */}
          <div
            className={cn(
              'tabular mt-2 text-[1.75rem] leading-none font-semibold tracking-tight',
              valueTone,
            )}
          >
            {value}
          </div>
        </div>

        {icon && (
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center self-start [&_svg]:size-4',
              iconTone,
            )}
          >
            {icon}
          </span>
        )}
      </div>

      {detail && <div className="mt-3">{detail}</div>}
      {hint && <p className="text-ink-3 mt-2 text-xs">{hint}</p>}
    </div>
  )
}
