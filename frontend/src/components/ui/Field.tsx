import type { ReactNode } from 'react'
import { controlClass } from './control'

/**
 * One labelled form control.
 *
 * Exists so every form on the dashboard gets the same label/hint/error rhythm
 * and, more importantly, the same accessibility wiring: the label is bound with
 * htmlFor, the hint and error are referenced by aria-describedby, and an
 * invalid field carries aria-invalid. Hand-rolling that per form is where it
 * quietly stops being done.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: (props: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': boolean | undefined
    className: string
  }) => ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div>
      {/* Small, tracked, quiet. A label the same size as its input competes
          with the value the person is trying to read back. */}
      <label htmlFor={id} className="text-ink-3 tracked mb-2 block text-[11px] font-medium">
        {label}
        {required && (
          <span className="text-accent/70 ml-1" aria-hidden>
            *
          </span>
        )}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        className: controlClass(Boolean(error)),
      })}

      {hint && !error && (
        <p id={hintId} className="text-ink-3 mt-2 text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-danger mt-2 text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
