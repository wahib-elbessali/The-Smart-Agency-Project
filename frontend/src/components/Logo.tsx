import { cn } from '@/components/ui/cn'

/**
 * The SmartAgency mark: two opposing arcs forming a loose S around a solid
 * centre dot.
 *
 * The dot is the branch; the arcs are the systems watching over it. The
 * product's real job is answering "is anything wrong right now?", so the mark
 * says "everything is in view" - oversight, which is broader and calmer than
 * protection. It replaced a shield on 2026-10-10: a shield implies a threat,
 * and a control room should feel like nothing is happening. The arcs wrap the
 * dot (looked after, not armed), arcs around a point read as a sensor or a
 * signal, and the S ties the mark to the name.
 *
 * WHY THE ARCS ARE OFFSET. Two arcs on one circle are a ring with gaps, and a
 * broken ring is exactly what loading and sync icons look like - on a
 * dashboard people take it for one. (The first version did that: two
 * same-centre spirals, 2026-10-10.) Here each arc has its own centre: the top
 * arc (over the top and down the left) is centred 1 unit up-left at (11, 11),
 * the bottom arc (round the right and along the bottom) 1 unit down-right at
 * (13, 13). Both are radius 8 and span 120 degrees, leaving 60-degree gaps at
 * top-right and bottom-left. The offset is what turns the pair into an S;
 * the wide gaps stop it closing into a ring.
 *
 * The bottom arc is the top arc rotated 180 degrees about (12, 12), so the
 * mark is point-symmetric and the dot sits at the true centre. Everything
 * stays 2 units inside the viewBox, stroke included.
 *
 * Drawn to match lucide-react: 24-unit viewBox, 2px stroke, round caps and
 * joins.
 *
 * Two colours only, both tokens, and the blue is the DOT:
 *   colour  arcs `text-ink`, dot `fill-accent`   - the default. The dot reads
 *           as a status light that is on, and blue stays rare. Never the
 *           other way round: a blue ring around a light dot is a selected
 *           radio button.
 *   mono    arcs and dot both `currentColor`     - for one-colour use, in
 *           print, anywhere the parent sets the colour
 *
 * public/favicon.svg carries the same geometry (and the same colour logic, on
 * a dark tile); change both together.
 */
export const ARC_PATHS = [
  'M13.07 3.27A8 8 0 0 0 3.27 13.07',
  'M20.73 10.93A8 8 0 0 1 10.93 20.73',
] as const

export function Logo({
  size = 24,
  variant = 'colour',
  className,
  title,
  pulse = false,
}: {
  /** Rendered width and height in px. */
  size?: number
  variant?: 'colour' | 'mono'
  className?: string
  /** Accessible name. Omit when a visible wordmark sits next to the mark. */
  title?: string
  /**
   * The status light "breathes": a faint ring leaves the dot and fades every
   * few seconds - the system is on and watching. For the large sign-in mark
   * ONLY. In the sidebar or any working screen a moving dot would read as
   * "something is happening", the opposite of what the mark should say there.
   * The arcs never move: rotating them would make the mark a loading spinner.
   * Under prefers-reduced-motion the global rule in index.css stops it on its
   * final, invisible frame, leaving a still dot.
   */
  pulse?: boolean
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn('shrink-0', variant === 'colour' && 'text-ink', className)}
    >
      {ARC_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
      {pulse && (
        /* Same size and colour as the dot, scaled out to just inside the arcs
           (2.2x = radius 5.5; the nearest arc edge is ~5.6), so the light
           stays enclosed by them. */
        <circle
          cx="12"
          cy="12"
          r="2.5"
          stroke="none"
          className={cn(
            'animate-beacon origin-center [transform-box:fill-box]',
            variant === 'colour' ? 'fill-accent' : 'fill-current',
          )}
        />
      )}
      <circle
        cx="12"
        cy="12"
        r="2.5"
        stroke="none"
        className={variant === 'colour' ? 'fill-accent' : 'fill-current'}
      />
    </svg>
  )
}
