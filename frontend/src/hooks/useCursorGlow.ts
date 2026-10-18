import { useEffect, useRef } from 'react'

/**
 * Tracks the pointer relative to an element and publishes it as CSS variables,
 * so a border glow can follow the cursor.
 *
 * The element gets three custom properties, which `.glow-edge` in index.css
 * reads:
 *
 *   --glow-x, --glow-y    pointer position in the element's own coordinates
 *   --glow-strength       0..1, how close the pointer is
 *
 * WHY CSS VARIABLES RATHER THAN REACT STATE. This updates on every pointer
 * move. Putting that in state would re-render the card - and everything inside
 * it - dozens of times a second for something no React component needs to know
 * about. Writing two custom properties skips reconciliation entirely and lets
 * the compositor do the work.
 *
 * PROXIMITY, NOT HOVER. The strength is computed from the distance to the
 * element's RECTANGLE, which is zero while the pointer is inside it. So the
 * glow fades in as the cursor approaches and is at full strength across the
 * whole card, instead of snapping on at the border the way :hover would.
 *
 * Reads are throttled to one per animation frame. getBoundingClientRect forces
 * layout, and doing that on every pointermove event - which can fire faster
 * than the display refreshes - is how a smooth effect turns into a janky one.
 */
export function useCursorGlow<T extends HTMLElement>(proximity = 180) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    let latest: { x: number; y: number } | null = null
    let frame = 0

    const apply = () => {
      frame = 0
      const point = latest
      if (!point) return

      const rect = element.getBoundingClientRect()
      if (rect.width === 0) return

      element.style.setProperty('--glow-x', `${point.x - rect.left}px`)
      element.style.setProperty('--glow-y', `${point.y - rect.top}px`)

      /* Distance from the point to the rectangle - zero anywhere inside it.
         Clamping each axis separately is the cheap way to get that. */
      const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
      const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
      const distance = Math.hypot(dx, dy)

      const strength = Math.max(0, 1 - distance / proximity)
      element.style.setProperty('--glow-strength', String(strength))
    }

    const onPointerMove = (event: PointerEvent) => {
      latest = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(apply)
    }

    const onPointerLeave = () => {
      latest = null
      element.style.setProperty('--glow-strength', '0')
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerleave', onPointerLeave)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [proximity])

  return ref
}
