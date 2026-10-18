import { useId } from 'react'
import { cn } from '@/components/ui/cn'

/**
 * A trend line at caption size: shape only, no axes, no labels.
 *
 * A sparkline answers "which way and how steadily", never "what value" - the
 * number it sits beside answers that. So there is deliberately no tooltip and
 * no hover layer here, which is the one documented exception to shipping an
 * interaction layer with every chart: there is nothing to reveal that the
 * adjacent figure does not already state.
 *
 * `vector-effect: non-scaling-stroke` is what makes this survive being stretched
 * to whatever width its container happens to be. The viewBox scales the
 * geometry on both axes independently; without that property the stroke would
 * scale with it and the line would come out 2px tall and 6px wide.
 */
export function Sparkline({
  values,
  tone = 'accent',
  width = 96,
  height = 28,
  className,
}: {
  values: number[]
  tone?: 'accent' | 'ok' | 'danger' | 'muted'
  width?: number
  height?: number
  className?: string
}) {
  const id = useId()

  if (values.length < 2) return null

  const stroke = {
    accent: 'var(--color-accent)',
    ok: 'var(--color-ok)',
    danger: 'var(--color-danger)',
    muted: 'var(--color-ink-3)',
  }[tone]

  const min = Math.min(...values)
  const max = Math.max(...values)
  /* A flat series would divide by zero and, worse, draw along the very bottom
     edge where it looks clipped. Centring it says "no change" honestly. */
  const span = max - min || 1

  const pad = 2
  const stepX = (100 - pad * 2) / (values.length - 1)

  const points = values.map((v, i) => {
    const x = pad + i * stepX
    const y = pad + (1 - (v - min) / span) * (100 - pad * 2)
    return [x, y] as const
  })

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')
  const area = `${line} L${points[points.length - 1][0]} 100 L${points[0][0]} 100 Z`

  const [lastX, lastY] = points[points.length - 1]

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={cn('overflow-visible', className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* The wash under the line carries the sense of volume that a 1px stroke
          alone does not, and it costs no extra ink at this size. */}
      <path d={area} fill={`url(#${id}-fill)`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* The end cap marks "now". Without it the eye has to hunt for which end
          is the recent one. */}
      <circle cx={lastX} cy={lastY} r={2.5} fill={stroke} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
