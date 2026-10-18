import { useState, type FormEvent } from 'react'
import { POINT_TYPES, type Service, type ServiceCreate } from '@/api/types'
import { ApiError, describeApiError } from '@/api/errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/**
 * Create / edit form for one service.
 *
 * Unlike AgencyForm, there is no create-vs-edit shape split here: PUT accepts
 * every field POST does, `code` included, so the same value set works for
 * both and only the submit label changes.
 */

export interface ServiceFormValues extends ServiceCreate {
  is_active: boolean
}

function initialValues(service: Service | null): ServiceFormValues {
  return {
    code: service?.code ?? '',
    name: service?.name ?? '',
    description: service?.description ?? '',
    point_type: service?.point_type ?? 'COUNTER',
    min_points: service?.min_points ?? 1,
    is_active: service?.is_active ?? true,
  }
}

/** Matches Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_-]+$") on code. */
function codeError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < 2 || trimmed.length > 50) return '2-50 characters.'
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return 'Letters, digits, "_" and "-" only.'
  return undefined
}

/** Matches Field(min_length=2, max_length=150) on name. */
function nameError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < 2 || trimmed.length > 150) return '2-150 characters.'
  return undefined
}

/**
 * Refusals verified against backend/app/api/services.py:
 *   409  code already used in this agency, agency is inactive, or (on update)
 *        point_type changed while a counter is still assigned
 *   404  the agency no longer exists
 */
function saveErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not save.'

  switch (error.status) {
    case 409:
      return 'That code is already used in this branch, or a counter is still assigned and blocks changing the point type.'
    case 404:
      return 'That branch no longer exists.'
    case 422:
      return 'The server rejected one of these values. Check the code format and the field lengths.'
    default:
      return describeApiError(error)
  }
}

export function ServiceForm({
  service,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  service: Service | null
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: ServiceFormValues) => void
}) {
  const editing = service !== null
  const [values, setValues] = useState(() => initialValues(service))
  const [touched, setTouched] = useState(false)

  const set = <K extends keyof ServiceFormValues>(key: K, value: ServiceFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const invalid =
    codeError(values.code, true) !== undefined || nameError(values.name, true) !== undefined

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (invalid) return

    onSubmit({
      ...values,
      code: values.code.trim(),
      name: values.name.trim(),
      description: values.description?.trim() || null,
    })
  }

  const serverMessage = saveErrorMessage(error)

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="service_code"
          label="Code"
          required
          error={codeError(values.code, touched)}
          hint="Unique within the branch, e.g. VIR."
        >
          {(props) => (
            <input
              {...props}
              value={values.code}
              onChange={(e) => set('code', e.target.value)}
              placeholder="VIR"
            />
          )}
        </Field>

        <Field id="service_name" label="Name" required error={nameError(values.name, touched)}>
          {(props) => (
            <input
              {...props}
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Virement et consultation"
            />
          )}
        </Field>
      </div>

      <Field id="service_description" label="Description" hint="Optional.">
        {(props) => (
          <input
            {...props}
            value={values.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
          />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="service_point_type"
          label="Point type"
          hint="COUNTER serves one visitor at a time; OFFICE handles work that does not."
        >
          {(props) => (
            <select
              {...props}
              value={values.point_type}
              onChange={(e) => set('point_type', e.target.value as ServiceFormValues['point_type'])}
            >
              {POINT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="service_min_points"
          label="Minimum points"
          hint="How many open points count as staffed."
        >
          {(props) => (
            <input
              {...props}
              type="number"
              min={1}
              max={100}
              value={values.min_points}
              onChange={(e) => set('min_points', Number(e.target.value))}
            />
          )}
        </Field>
      </div>

      <Field id="service_active" label="Status">
        {(props) => (
          <select
            {...props}
            value={values.is_active ? 'active' : 'inactive'}
            onChange={(e) => set('is_active', e.target.value === 'active')}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        )}
      </Field>

      {serverMessage && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
        >
          {serverMessage}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onCancel} type="button">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create service'}
        </Button>
      </div>
    </form>
  )
}
