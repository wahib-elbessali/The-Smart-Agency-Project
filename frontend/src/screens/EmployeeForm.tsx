import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAccessZones } from '@/api/endpoints/accessZones'
import { EMPLOYEE_STATUSES, type Agency, type Employee, type EmployeeCreate } from '@/api/types'
import { ApiError, describeApiError } from '@/api/errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { EmployeeFacePanel } from './EmployeeFacePanel'

/**
 * Create / edit form for one employee.
 *
 * The split on validation is deliberate. The form checks only what it can know
 * for certain from the schema - that both names are present and at least two
 * characters, matching Field(min_length=2). Everything else the backend
 * enforces (email and RFID uniqueness, whether an agency exists) depends on
 * data the browser does not have, and guessing at it would produce a form that
 * rejects valid input - worse than one that occasionally shows a server error.
 *
 * What the form does owe the person is a readable message when the server does
 * refuse. Every failure this endpoint can produce is mapped below, because
 * "The server rejected the request (409)" tells someone filling in a form
 * nothing about what to change.
 */

export interface EmployeeFormValues extends EmployeeCreate {
  first_name: string
  last_name: string
}

function initialValues(employee: Employee | null, agencyId: string | null): EmployeeFormValues {
  return {
    first_name: employee?.first_name ?? '',
    last_name: employee?.last_name ?? '',
    email: employee?.email ?? '',
    phone: employee?.phone ?? '',
    position: employee?.position ?? '',
    rfid_uid: employee?.rfid_uid ?? '',
    hire_date: employee?.hire_date ?? '',
    status: employee?.status ?? 'ACTIVE',
    agency_id: employee?.agency_id ?? agencyId ?? '',
    authorized_zone_ids: employee?.authorized_zone_ids ?? [],
  }
}

/** Matches Field(min_length=2) on both name fields. */
const MIN_NAME = 2

function nameError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < MIN_NAME) return `At least ${MIN_NAME} characters.`
  return undefined
}

/**
 * Turns a refusal into something actionable.
 *
 * The backend's own `detail` strings are in French, and the interface is in
 * English, so they are mapped rather than shown raw. Each of these was observed
 * against the running API, not guessed:
 *   409 "Email ou carte RFID deja utilise"
 *   422 "Statut invalide" / "agency_id est obligatoire pour un ADMIN"
 *   404 "Agence introuvable" / "Zone introuvable" (a door zone deleted meanwhile)
 */
function saveErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not save.'

  switch (error.status) {
    case 409:
      return 'That email or RFID card already belongs to another employee.'
    case 422:
      return 'The server rejected one of these values. Check the card number and the status.'
    case 404:
      return 'That agency or one of the ticked badge rooms no longer exists. Reopen the form and try again.'
    default:
      return describeApiError(error)
  }
}

/** Empty strings become null: the API treats "" and absent very differently. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function EmployeeForm({
  employee,
  agencies,
  defaultAgencyId,
  canChooseAgency,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  employee: Employee | null
  agencies: Agency[]
  defaultAgencyId: string | null
  /** False for a MANAGER: the backend forces their agency regardless. */
  canChooseAgency: boolean
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: EmployeeCreate) => void
}) {
  const [values, setValues] = useState(() => initialValues(employee, defaultAgencyId))
  const [touched, setTouched] = useState(false)

  const firstNameError = nameError(values.first_name, touched)
  const lastNameError = nameError(values.last_name, touched)
  const nameInvalid =
    nameError(values.first_name, true) !== undefined ||
    nameError(values.last_name, true) !== undefined
  const set = <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  /* Door zones belong to one branch, so the list follows the branch picked
     above; switching branch drops the ticks, since the old ids would be
     refused (404) by the new branch. */
  const zonesAgencyId = values.agency_id || null
  const accessZones = useQuery({
    queryKey: ['access-zones', zonesAgencyId],
    queryFn: ({ signal }) => fetchAccessZones(zonesAgencyId as string, signal),
    enabled: zonesAgencyId !== null,
  })
  const selectedZones = values.authorized_zone_ids ?? []
  const toggleZone = (id: string) =>
    set(
      'authorized_zone_ids',
      selectedZones.includes(id) ? selectedZones.filter((z) => z !== id) : [...selectedZones, id],
    )

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (nameInvalid) return

    onSubmit({
      first_name: values.first_name.trim(),
      last_name: values.last_name.trim(),
      email: blankToNull(values.email),
      phone: blankToNull(values.phone),
      position: blankToNull(values.position),
      rfid_uid: blankToNull(values.rfid_uid),
      hire_date: blankToNull(values.hire_date),
      status: values.status,
      authorized_zone_ids: selectedZones,
      ...(canChooseAgency ? { agency_id: blankToNull(values.agency_id) } : {}),
    })
  }

  const serverMessage = saveErrorMessage(error)

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="first_name" label="First name" required error={firstNameError}>
          {(props) => (
            <input
              {...props}
              value={values.first_name}
              onChange={(e) => set('first_name', e.target.value)}
            />
          )}
        </Field>

        <Field id="last_name" label="Last name" required error={lastNameError}>
          {(props) => (
            <input
              {...props}
              value={values.last_name}
              onChange={(e) => set('last_name', e.target.value)}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="email" label="Email" hint="Optional. Must be unique.">
          {(props) => (
            <input
              {...props}
              type="email"
              value={values.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
            />
          )}
        </Field>

        <Field id="phone" label="Phone">
          {(props) => (
            <input
              {...props}
              value={values.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="position" label="Position">
          {(props) => (
            <input
              {...props}
              value={values.position ?? ''}
              onChange={(e) => set('position', e.target.value)}
            />
          )}
        </Field>

        <Field id="rfid_uid" label="RFID card" hint="Optional. Must be unique.">
          {(props) => (
            <input
              {...props}
              value={values.rfid_uid ?? ''}
              onChange={(e) => set('rfid_uid', e.target.value)}
              placeholder="RFID-001"
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="hire_date" label="Hire date">
          {(props) => (
            <input
              {...props}
              type="date"
              value={values.hire_date ?? ''}
              onChange={(e) => set('hire_date', e.target.value)}
            />
          )}
        </Field>

        <Field
          id="status"
          label="Status"
          hint="INACTIVE keeps the record and its attendance history."
        >
          {(props) => (
            <select
              {...props}
              value={values.status}
              onChange={(e) => set('status', e.target.value as EmployeeFormValues['status'])}
            >
              {EMPLOYEE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {canChooseAgency && (
        <Field id="agency_id" label="Agency" required hint="Required when creating as an admin.">
          {(props) => (
            <select
              {...props}
              value={values.agency_id ?? ''}
              onChange={(e) =>
                setValues((current) => ({
                  ...current,
                  agency_id: e.target.value,
                  authorized_zone_ids: [],
                }))
              }
            >
              <option value="">Select an agency…</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      <fieldset>
        <legend className="text-ink-2 text-sm font-medium">Badge room access</legend>
        <p className="text-ink-3 mt-0.5 text-xs">Rooms this employee&apos;s badge opens.</p>
        {zonesAgencyId === null ? (
          <p className="text-ink-3 mt-2 text-sm">Pick an agency first.</p>
        ) : accessZones.isPending ? (
          <p className="text-ink-3 mt-2 text-sm">Loading…</p>
        ) : accessZones.error ? (
          <p className="text-warn mt-2 text-sm">Could not load this branch&apos;s badge rooms.</p>
        ) : accessZones.data.length === 0 ? (
          <p className="text-ink-3 mt-2 text-sm">
            This branch has no badge rooms yet - add them in its agency Settings.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {accessZones.data.map((zone) => (
              <label key={zone.id} className="text-ink flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedZones.includes(zone.id)}
                  onChange={() => toggleZone(zone.id)}
                />
                {zone.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {/* Only once the employee exists: the face is filed under their id. */}
      {employee && <EmployeeFacePanel employeeId={employee.id} />}

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
        {/* "Create employee", not "Add employee": the toolbar button that
            opens this dialog is already called Add employee, and two controls
            sharing one accessible name is ambiguous to anyone navigating by
            name rather than by sight. */}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : employee ? 'Save changes' : 'Create employee'}
        </Button>
      </div>
    </form>
  )
}
