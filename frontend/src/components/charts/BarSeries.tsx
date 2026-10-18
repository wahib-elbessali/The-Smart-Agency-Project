import { useId, useState } from 'react'
import { cn } from '@/components/ui/cn'

/**
 * A single-series column chart: magnitude over an ordered axis.
 *
 * BUILT IN HTML, NOT SVG, and that is the interesting choice here. An SVG bar
 * chart has to either scale its viewBox - which stretches the corner radii and
 * the hairlines along with the bars - or measure its own container to lay out
 * in real pixels. Flex children sized in percentages dodge both: the radius
 * stays 4px and the gap stays 2px at every width, the bars are real DOM nodes
 * so hover and focus come from the browser, and there is no resize observer.
 *
 * ONE LIT BAR, THE REST MUTED. This is the pattern worth stealing from any good
 * dashboard: colouring every column identically means the chart answers "what
 * are the values" and nothing else, while muting all but one makes it answer
 * "which one matters", which is the question the viewer actually arrived with.
 * The lit colour sits outside the categorical lightness band deliberately - see
 * --color-data-lit in index.css.
 *
 * The value labels are NOT drawn on every bar. A number over each column is the
 * fastest way to turn a chart back into a table; the shape carries the
 * comparison and the tooltip carries the precision.
 */

export interface BarDatum {
  label: string
  value: number
}

export function BarSeries({
  data,
  litIndex,
  format = (n: number) => String(n),
  height = 160,
  emptyLabel = 'No data for this period',
  className,
}: {
  data: BarDatum[]
  /** Index of the one bar that gets the accent. Omit for an all-muted chart. */
  litIndex?: number
  format?: (value: number) => string
  height?: number
  emptyLabel?: string
  className?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const id = useId()

  if (data.length === 0) {
    return (
      <p className="text-ink-3 flex items-center justify-center text-sm" style={{ height }}>
        {emptyLabel}
      </p>
    )
  }

  /* Scale to the tallest bar, not to a round number above it. A chart of eight
     values where the tallest reaches 60% of the frame wastes the top of the
     panel and flattens every difference below it. */
  const peak = Math.max(...data.map((d) => d.value), 1)

  return (
    <div className={cn('w-full', className)}>
      {/* Columns own their own label, so the bar and the tick under it cannot
          drift apart - two parallel flex rows have to be kept in sync by hand
          and eventually are not.

          The width cap is what keeps this reading as a chart. Five buckets
          across a wide panel gives each bar ninety pixels of flex, at which
          point the 4px corner radius is invisible and the result looks like a
          block diagram. Marks stay thin; the leftover space becomes margin. */}
      <div className="flex items-end justify-center gap-2">
        {data.map((d, i) => {
          const lit = i === litIndex
          const isActive = active === i
          /* A floor, so a zero or near-zero value is still a visible mark
             rather than a gap the eye reads as missing data. */
          const pct = Math.max((d.value / peak) * 100, 1.5)

          return (
            /* The COLUMN is capped, not just the bar inside it. Capping only
               the bar leaves each column taking an equal share of a wide panel,
               so five bars end up eighty pixels apart and the chart reads as
               five unrelated readings rather than one series. Capping the
               column lets the group cluster and centre. */
            <div key={d.label} className="flex min-w-0 max-w-[68px] flex-1 flex-col items-center">
              <button
                type="button"
                /* A button, not a div: the tooltip has to be reachable without
                   a mouse, and this is a wall dashboard that gets driven by
                   keyboard as often as not. */
                aria-describedby={isActive ? `${id}-tip-${i}` : undefined}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="ease-soft relative flex w-full max-w-[46px] cursor-default items-end rounded-t-[4px] transition-colors duration-150"
                style={{ height }}
              >
                <span
                  className={cn(
                    'ease-soft w-full rounded-t-[4px] transition-[opacity,background-color] duration-200',
                    lit ? 'bg-data-lit' : 'bg-line-strong',
                    /* Peers dim slightly when another bar is being read, so the
                       one under the cursor separates without changing colour. */
                    active !== null && !isActive && 'opacity-55',
                    isActive && !lit && 'bg-ink-3',
                  )}
                  style={{ height: `${pct}%` }}
                />

                {isActive && (
                  <span
                    id={`${id}-tip-${i}`}
                    role="tooltip"
                    className="bg-panel-2 ring-line-strong text-ink shadow-raised pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-[0.5rem] px-3 py-2 text-xs whitespace-nowrap ring-1"
                  >
                    <span className="text-ink-3">{d.label}</span>{' '}
                    <span className="tabular font-medium">{format(d.value)}</span>
                  </span>
                )}
              </button>

              {/* The axis is recessive on purpose: it orients, it does not
                  compete. Every other label is dropped past eight columns,
                  because overlapping tick text is the single most common way a
                  chart stops being readable at narrow widths. */}
              <span
                className={cn(
                  'text-ink-3 mt-2 w-full truncate text-center text-[10px]',
                  data.length > 8 && i % 2 === 1 && 'invisible',
                )}
              >
                {d.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
