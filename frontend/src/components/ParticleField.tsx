import { useEffect, useRef } from 'react'

/**
 * A full-page grid of fine dots that bulges away from the pointer.
 *
 * Modelled on the ReactBits "Dot Field" background, and deliberately much
 * quieter than the flowing/undulating versions this replaced. The field is
 * STILL until the pointer arrives - no ambient drift, no wave - so the only
 * motion on screen is the one the person is causing. On a sign-in page that
 * reads as responsive rather than busy.
 *
 * THE GRID IS REGULAR, NOT JITTERED. That is the opposite of the usual advice
 * for particle fields, and it is right here: the effect depends on seeing the
 * lattice deform. Jitter would hide the displacement in noise, because there
 * would be no straight line for the eye to notice bending.
 *
 * THE BULGE. Dots are pushed radially away from the pointer with a quadratic
 * falloff, so the deformation is strongest at the centre and fades to nothing
 * at the influence radius with no visible edge. Each dot eases toward its
 * displaced target rather than snapping, which is what makes the field feel
 * elastic - it lags slightly behind a fast cursor and settles after it.
 *
 * ONE FILL CALL FOR THE WHOLE FIELD. Every dot is added to a single path and
 * filled once with a canvas-wide gradient. That is why the dots share a smooth
 * colour ramp across the page without any per-dot colour work, and why ~5800
 * dots cost almost nothing: the alternative, a fill per dot, is thousands of
 * state changes a frame.
 *
 * Drawn in CSS pixels with a devicePixelRatio transform, so the tuning
 * constants are real screen distances and the dots stay crisp on any display.
 *
 * Honours prefers-reduced-motion by drawing the resting grid once.
 */

/** ReactBits defaults, kept so the feel matches the reference. */
const DOT_RADIUS = 1.5
const DOT_SPACING = 14
/** Distance between dot centres. */
const STEP = DOT_RADIUS + DOT_SPACING
/** How far the pointer's influence reaches, in CSS pixels. */
const CURSOR_RADIUS = 500
/** Peak displacement at the centre of the bulge, in CSS pixels. */
const BULGE_STRENGTH = 67
/** Easing toward the displaced target, per frame. */
const SMOOTHING = 0.15
/** How quickly the effect fades in when the pointer appears, and out when it leaves. */
const ENGAGE_RATE = 0.06

interface Dot {
  /** Resting position - the dot always returns here. */
  ax: number
  ay: number
  /** Current drawn position. */
  x: number
  y: number
}

function parseColor(value: string): [number, number, number] {
  const v = value.trim()
  if (v.startsWith('#')) {
    const n = v.slice(1)
    const f = n.length === 3 ? n.replace(/./g, (c) => c + c) : n
    return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
  }
  const m = v.match(/\d+/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [255, 255, 255]
}

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

export function ParticleField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    /* The gradient runs corner to corner across the page. Built from the theme
       tokens rather than the reference's purple, so the field belongs to
       whichever theme is active - light dots on navy, ink dots on white. */
    let gradient: CanvasGradient | null = null
    let width = 0
    let height = 0

    const buildGradient = () => {
      const styles = getComputedStyle(document.documentElement)
      const accent = parseColor(styles.getPropertyValue('--color-accent'))
      const ink = parseColor(styles.getPropertyValue('--color-ink'))
      const g = ctx.createLinearGradient(0, 0, width, height)
      g.addColorStop(0, rgba(accent, 0.45))
      g.addColorStop(1, rgba(ink, 0.3))
      gradient = g
    }

    let dots: Dot[] = []

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      /* Work in CSS pixels: the constants above are real screen distances and
         should not change meaning with the display's pixel density. */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      /* Centre the lattice, so it is not clipped unevenly at the edges. */
      const padX = ((width % STEP) + STEP) / 2
      const padY = ((height % STEP) + STEP) / 2

      const next: Dot[] = []
      for (let y = padY; y < height; y += STEP) {
        for (let x = padX; x < width; x += STEP) {
          next.push({ ax: x, ay: y, x, y })
        }
      }
      dots = next
      buildGradient()
    }

    let pointer: { x: number; y: number } | null = null
    /* 0..1. Ramps rather than switching, so the field settles when the pointer
       leaves instead of snapping back. */
    let engagement = 0

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const onPointerLeave = () => {
      pointer = null
    }

    const step = () => {
      ctx.clearRect(0, 0, width, height)

      if (!reduced) {
        engagement += ((pointer ? 1 : 0) - engagement) * ENGAGE_RATE
      }

      const active = !reduced && pointer !== null && engagement > 0.01

      for (const d of dots) {
        let tx = d.ax
        let ty = d.ay

        if (active && pointer) {
          const dx = d.ax - pointer.x
          const dy = d.ay - pointer.y
          const distance = Math.hypot(dx, dy)

          if (distance < CURSOR_RADIUS && distance > 0.001) {
            /* Quadratic falloff: strongest at the pointer, nothing at the
               radius, and no visible boundary where it stops. */
            const t = 1 - distance / CURSOR_RADIUS
            const push = t * t * BULGE_STRENGTH * engagement
            tx = d.ax + (dx / distance) * push
            ty = d.ay + (dy / distance) * push
          }
        }

        /* Ease toward the target. The lag is the point - it makes the lattice
           behave like a sheet being pushed rather than a set of dots teleporting. */
        d.x += (tx - d.x) * SMOOTHING
        d.y += (ty - d.y) * SMOOTHING
      }

      /* Every dot in ONE path, filled once. A fill per dot would be thousands
         of state changes a frame; this is a single draw. */
      ctx.beginPath()
      const r = DOT_RADIUS / 2
      for (const d of dots) {
        ctx.moveTo(d.x + r, d.y)
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2)
      }
      if (gradient) ctx.fillStyle = gradient
      ctx.fill()

      frame = reduced ? 0 : requestAnimationFrame(step)
    }

    resize()
    let frame = requestAnimationFrame(step)

    const themeObserver = new MutationObserver(buildGradient)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerleave', onPointerLeave)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      themeObserver.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])

  return (
    /* aria-hidden and pointer-events-none: decoration, and it must never
       intercept a click meant for the form sitting over it. */
    <canvas ref={canvasRef} aria-hidden className={className} />
  )
}
