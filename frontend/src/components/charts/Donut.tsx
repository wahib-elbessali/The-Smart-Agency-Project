import { useState } from 'react'
import { cn } from '@/components/ui/cn'

/**
 * Part-to-whole for a small number of categories, with the total in the middle.
 *
 * Drawn with stroke-dasharray on concentric circles rather than with arc paths.
 * The trigonometry is the same either way, but a dashed stroke gives an even
 * cap and an exact gap for free, and there is no large-arc-flag to get wrong on
 * the one segment that happens to exceed half the circle.
 *
 * THE GAP IS 2px AT RENDER SIZE, not 2 units of the viewBox. Segments that
 * touch read as one continuous ring with colour changes; a consistent sliver of
 * background between them reads as separate quantities, which is the entire
 * point of the chart. Because the viewBox is fixed and the render size is not,
 * that conversion has to be done explicitly.
 *
 * The centre shows the total until a segment is hovered, then that segment.
 * It replaces a floating tooltip: the number the reader wants appears in the
 * one place they are already looking, and nothing overlaps the ring.
 */

export interface DonutSegment {
  label: string
  value: number
  color: string
}

const BOX = 100
const RADIUS = 42

export function Donut({
  segments,
  total,
  totalLabel,
  format = (n: number) => String(n),
  size = 180,
  thickness = 13,
  className,
}: {
  segments: DonutSegment[]
  /** Defaults to the sum. Pass it when the ring is a subset of a larger whole. */
  total?: number
  totalLabel?: string
  format?: (value: number) => string
  size?: number
  thickness?: number
  className?: string
}) {
  const [active, setActive] = useState<number | null>(null)

  const sum = segments.reduce((n, s) => n + s.value, 0)
  const whole = total ?? sum

  const circumference = 2 * Math.PI * RADIUS
  /* viewBox units per rendered pixel, so the gap lands at 2 real pixels. */
  const gap = (2 * BOX) / size

  const shown = active === null ? null : segments[active]

  let cursor = 0

  return (
    <div className={cn('flex flex-wrap items-center gap-x-8 gap-y-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${BOX} ${BOX}`}
          className="size-full -rotate-90"
          role="img"
          aria-label={`${totalLabel ?? 'Total'}: ${format(whole)}`}
        >
          {/* The track. Without it a ring made of a few small segments looks
              like a broken circle rather than a mostly-empty one. */}
          <circle
            cx={BOX / 2}
            cy={BOX / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--color-panel-2)"
            strokeWidth={thickness}
          />

          {segments.map((s, i) => {
            const fraction = whole === 0 ? 0 : s.value / whole
            const length = Math.max(fraction * circumference - gap, 0)
            const offset = -cursor
            cursor += fraction * circumference

            return (
              <circle
                key={s.label}
                cx={BOX / 2}
                cy={BOX / 2}
                r={RADIUS}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeLinecap="butt"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={offset}
                className={cn(
                  'ease-soft transition-opacity duration-200',
                  active !== null && active !== i && 'opacity-35',
                )}
              />
            )
          })}
        </svg>

        {/* Centred readout. pointer-events-none so it never blocks the ring. */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div className="px-6">
            <div className="text-ink tabular text-[1.4rem] leading-none font-light tracking-tight">
              {format(shown ? shown.value : whole)}
            </div>
            <div className="text-ink-3 mt-1 truncate text-[11px]">
              {shown ? shown.label : (totalLabel ?? 'Total')}
            </div>
          </div>
        </div>
      </div>

      {/* The legend is always present, and it is also the hover surface. A ring
          this size has segments too thin to be reliable click targets, and the
          label is what the reader is looking for anyway. */}
      <ul className="min-w-0 flex-1 space-y-2">
        {segments.map((s, i) => (
          <li key={s.label}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className={cn(
                'rounded-control ease-soft flex w-full cursor-default items-center gap-2 px-2 py-1 text-left transition-colors duration-150',
                active === i ? 'bg-panel-2' : 'hover:bg-panel-2/60',
              )}
            >
              {/* A bar rather than a dot. At 3x10 it holds its hue at a glance
                  from across a room, where a 8px dot turns into a speck. */}
              <span
                aria-hidden
                className="h-2.5 w-[3px] shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-ink-2 min-w-0 flex-1 truncate text-xs">{s.label}</span>
              <span className="text-ink tabular text-xs font-medium">{format(s.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
