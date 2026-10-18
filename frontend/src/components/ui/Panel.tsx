import type { ReactNode } from 'react'
import { cn } from './cn'
import { useCursorGlow } from '@/hooks/useCursorGlow'

/**
 * The single card surface. Every boxed region on every screen is one of these,
 * so panels can't drift into slightly different greys and radii.
 *
 * A panel is GLASS, not a fill. Its surface is a diagonal gradient that fades
 * from nearly opaque to about half, over a heavy backdrop blur - so the page
 * shows through the far corner of every card as diffuse light.
 *
 * That is the whole look, and it is easy to lose. An opaque fill of the same
 * average colour produces a perfectly competent dark theme that resembles the
 * design not at all, because what the eye reads is not the colour but the
 * depth: a pane resting above the page rather than a hole cut into it. The
 * 20px radius is part of the same effect - tighten it and the pane goes back
 * to reading as a cut-out.
 *
 * No border. The design draws none, and on a translucent surface a hairline is
 * the one thing that would give away that this is a rectangle rather than
 * glass. The shadow does the separating instead: wide, far below, and very
 * faint, which is all a near-black page can carry.
 */
export function Panel({
  children,
  className,
  tone = 'neutral',
  glow = false,
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  /** `alert` is for the one loud thing on screen, not for every warning. */
  tone?: 'neutral' | 'alert'
  /**
   * Lights the panel's edge with a pool of accent that follows the pointer.
   *
   * Opt-in rather than always on. It draws the eye, which is right for the one
   * card a screen is about - the sign-in box - and wrong for a dashboard where
   * eight panels would all be competing for attention at once.
   */
  glow?: boolean
  as?: 'div' | 'section' | 'article'
}) {
  const glowRef = useCursorGlow<HTMLDivElement>()

  return (
    <Tag
      ref={glow ? glowRef : undefined}
      className={cn(
        'rounded-panel shadow-panel',
        glow && 'glow-edge',
        tone === 'alert'
          ? /* An alert panel earns a real border. It is the one case where the
               outline is the point rather than decoration. */
            'border-warn/30 bg-warn/6 border'
          : /* No hover state. Most panels are not clickable, and a card
               that lifts or lights up under the pointer promises an action
               it does not have. Clickable cards style their own hover. */
            'surface-glass',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

/**
 * A panel header, separated by space rather than a rule.
 *
 * The old version drew a line under every header. Removing it and letting the
 * padding do the separating is most of why this now reads as quieter - a rule
 * is a strong signal, and spending one on "here is a title" leaves nothing
 * left for the divisions that actually matter.
 *
 * `action` is the slot on the right. It exists so the affordance for "there is
 * more behind this card" has one shape and one position on every panel instead
 * of each screen inventing its own.
 */
export function PanelHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-6 pt-4 pb-1">
      <div className="min-w-0">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/**
 * `flush` drops the padding for content that runs edge to edge - a table whose
 * own cells carry the 24px inset, so its first column lines up with the panel
 * title. A prop rather than `className="px-0"`, because `cn` only joins class
 * names: `px-0` and `px-6` both land on the element and the later one in the
 * stylesheet (`px-6`) wins, which left every table double-inset.
 */
export function PanelBody({
  children,
  className,
  flush = false,
}: {
  children: ReactNode
  className?: string
  flush?: boolean
}) {
  return <div className={cn(!flush && 'px-6 py-4', className)}>{children}</div>
}
