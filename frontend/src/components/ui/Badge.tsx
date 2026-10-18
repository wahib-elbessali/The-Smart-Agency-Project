import type { ReactNode } from 'react'
import { cn } from './cn'

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

/**
 * A tinted fill rather than an outline.
 *
 * Outlined pills are the default everywhere, which is exactly why they read as
 * unconsidered. A low-opacity fill of the tone's own colour sits quieter on a
 * dark surface, keeps its identity when there are five of them in a table
 * column, and stops the badge competing with the panel edge behind it.
 */
const TONES: Record<Tone, string> = {
  neutral: 'bg-line-strong/40 text-ink-2',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
}

/**
 * Status pill. Always takes an icon or a word as well as a tone - colour alone
 * never carries meaning, since a chunk of people can't separate these hues.
 */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        /* Tighter and smaller than before. A badge is an annotation, and the
           old one was sized like a control - which made every table row look
           like it had buttons in it. */
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}
