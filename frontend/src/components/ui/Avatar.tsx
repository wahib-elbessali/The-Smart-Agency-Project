import { cn } from './cn'

/**
 * Initials stand-in for a photo.
 *
 * No employee photo field exists in contracts/api.md, so there is no image to
 * load - and the hue is derived from the name rather than assigned, so the same
 * person is the same colour on every render and across reloads without any
 * state. Purely decorative: the name is always next to it in text.
 *
 * The hue is confined to a window rather than spanning the whole wheel. Free
 * choice of 360 degrees means a roster of ten people puts a green, an orange
 * and a red disc on a navy screen, and those read as foreign objects rather
 * than as avatars - the eye clocks them as status colours meaning something,
 * which on a dashboard where green really does mean "ok" is worse than merely
 * untidy. Restricting to the cyan-blue-violet arc the palette already occupies
 * keeps every person distinguishable from their neighbour while leaving the
 * screen one family of colour.
 */
const HUE_START = 210
const HUE_SPAN = 120

function hueOf(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360
  }
  return HUE_START + (hash % HUE_SPAN)
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const hue = hueOf(name)

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold',
        className,
      )}
      style={{
        /* Hue is per person, lightness is per theme. The disc has to be dark
           with light initials on the dark theme and the reverse on the light
           one, so the two L values come from tokens while the hue stays
           computed here - see --avatar-bg-l in index.css. */
        backgroundColor: `oklch(var(--avatar-bg-l) 0.06 ${hue})`,
        color: `oklch(var(--avatar-fg-l) 0.09 ${hue})`,
      }}
    >
      {initialsOf(name)}
    </span>
  )
}
