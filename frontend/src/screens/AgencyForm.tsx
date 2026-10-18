import { useState, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import {
  POINT_TYPES,
  type Agency,
  type AgencyCreate,
  type CounterCreate,
  type ZoneCreate,
} from '@/api/types'
import { ApiError, describeApiError } from '@/api/errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { controlClass } from '@/components/ui/control'

/**
 * Create / edit form for one agency.
 *
 * TWO SHAPES IN ONE FORM, because the contract gives the two routes different
 * bodies rather than one body used twice:
 *
 * - Zones and counters can only be sent to POST, and PUT's documented body
 *   still does not mention them - so they are editable while creating and
 *   absent while editing here too, not disabled. Counters DO now have their
 *   own routes for after creation (POST/PUT/DELETE /counters, added
 *   2026-09-23, UX_AUDIT.md finding 4 - see AgencyDetail.tsx's
 *   CountersPanel), so "absent while editing" is this form's own choice to
 *   stay a plain create/rename-the-branch form, not a hard backend limit
 *   the way it used to be. Zones still have no separate route at all.
 * - `is_active` is the reverse: PUT accepts it, POST does not. A new agency is
 *   active by definition.
 *
 * The same split on validation as the employee form. This checks the one bound
 * the contract states - name 2-150 characters - plus counter numbers, which it
 * can check because a duplicate is visible in the form itself. Everything else
 * is the server's to judge.
 */

export interface AgencyFormValues {
  name: string
  address: string
  phone: string
  opening_time: string
  closing_time: string
  is_active: boolean
  zones: ZoneCreate[]
  counters: CounterCreate[]
}

/** The contract's stated bound on `name`. */
const MIN_NAME = 2
const MAX_NAME = 150

/**
 * "08:30:00" from the API, "08:30" in an <input type="time">.
 *
 * The input never produces seconds, and the API always sends them. Handing the
 * raw API value to the input makes some browsers silently blank the field,
 * which reads as the agency having no opening time at all.
 */
function toTimeInput(value: string | null): string {
  if (!value) return ''
  const [h, m] = value.split(':')
  return h && m ? `${h}:${m}` : ''
}

function fromTimeInput(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed
}

function initialValues(agency: Agency | null): AgencyFormValues {
  return {
    name: agency?.name ?? '',
    address: agency?.address ?? '',
    phone: agency?.phone ?? '',
    opening_time: toTimeInput(agency?.opening_time ?? null),
    closing_time: toTimeInput(agency?.closing_time ?? null),
    is_active: agency?.is_active ?? true,
    zones: [],
    counters: [],
  }
}

function nameError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < MIN_NAME) return `At least ${MIN_NAME} characters.`
  if (trimmed.length > MAX_NAME) return `At most ${MAX_NAME} characters.`
  return undefined
}

/**
 * Duplicate counter numbers, found before the server has to refuse them.
 *
 * This is one of the few server rules worth reproducing on the client, because
 * unlike uniqueness across the database it is entirely visible in the form -
 * both offending rows are on screen. Returns the set of duplicated numbers so
 * each one can be marked rather than showing a single message about "a"
 * duplicate somewhere.
 */
function duplicateNumbers(counters: CounterCreate[]): Set<number> {
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const counter of counters) {
    if (seen.has(counter.number)) duplicates.add(counter.number)
    seen.add(counter.number)
  }
  return duplicates
}

function saveErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not save.'

  switch (error.status) {
    case 409:
      return 'Two counters share the same number. Every counter number must be unique within the agency.'
    case 422:
      return 'The server rejected one of these values. Check the name length and the opening times.'
    case 403:
      return 'Only administrators can create or delete an agency. A manager can edit their own.'
    case 404:
      return 'That agency no longer exists.'
    default:
      return describeApiError(error)
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function AgencyForm({
  agency,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  agency: Agency | null
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: AgencyCreate & { is_active?: boolean }) => void
}) {
  const editing = agency !== null
  const [values, setValues] = useState(() => initialValues(agency))
  const [touched, setTouched] = useState(false)

  const set = <K extends keyof AgencyFormValues>(key: K, value: AgencyFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const duplicates = duplicateNumbers(values.counters)
  const invalid = nameError(values.name, true) !== undefined || duplicates.size > 0

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (invalid) return

    const common = {
      name: values.name.trim(),
      address: blankToNull(values.address),
      phone: blankToNull(values.phone),
      opening_time: fromTimeInput(values.opening_time),
      closing_time: fromTimeInput(values.closing_time),
    }

    onSubmit(
      editing
        ? { ...common, is_active: values.is_active }
        : {
            ...common,
            /* Omitted entirely when empty rather than sent as []. Both are
               accepted, but an absent key says "nothing to create here" while
               an empty list invites the question of whether it clears. */
            ...(values.zones.length > 0 ? { zones: values.zones } : {}),
            ...(values.counters.length > 0 ? { counters: values.counters } : {}),
          },
    )
  }

  const serverMessage = saveErrorMessage(error)

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        id="agency_name"
        label="Name"
        required
        error={nameError(values.name, touched)}
        hint={`${MIN_NAME}-${MAX_NAME} characters.`}
      >
        {(props) => (
          <input {...props} value={values.name} onChange={(e) => set('name', e.target.value)} />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="agency_address" label="Address">
          {(props) => (
            <input
              {...props}
              value={values.address}
              onChange={(e) => set('address', e.target.value)}
            />
          )}
        </Field>

        <Field id="agency_phone" label="Phone">
          {(props) => (
            <input {...props} value={values.phone} onChange={(e) => set('phone', e.target.value)} />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="agency_opening" label="Opening time" hint="Arrivals after this are marked late.">
          {(props) => (
            <input
              {...props}
              type="time"
              value={values.opening_time}
              onChange={(e) => set('opening_time', e.target.value)}
            />
          )}
        </Field>

        <Field id="agency_closing" label="Closing time">
          {(props) => (
            <input
              {...props}
              type="time"
              value={values.closing_time}
              onChange={(e) => set('closing_time', e.target.value)}
            />
          )}
        </Field>
      </div>

      {editing ? (
        <Field
          id="agency_active"
          label="Status"
          hint="Inactive is reversible and keeps every employee, counter and record."
        >
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
      ) : (
        <>
          <RepeatableCounters
            counters={values.counters}
            duplicates={duplicates}
            onChange={(counters) => set('counters', counters)}
          />
          <RepeatableZones zones={values.zones} onChange={(zones) => set('zones', zones)} />
        </>
      )}

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
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create agency'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Counters, editable only while creating.
 *
 * The warning is not decoration. Once this agency exists the contract offers no
 * way to add a counter, and a ticket cannot be called to a counter that does
 * not exist - so an agency created with none has a visitor queue that can never
 * be served. Saying that here is cheaper than discovering it later.
 */
function RepeatableCounters({
  counters,
  duplicates,
  onChange,
}: {
  counters: CounterCreate[]
  duplicates: Set<number>
  onChange: (counters: CounterCreate[]) => void
}) {
  const add = () => {
    /* Next free number rather than always 1, so adding three counters in a row
       does not produce three duplicates the person then has to fix. */
    const used = new Set(counters.map((c) => c.number))
    let next = 1
    while (used.has(next)) next += 1
    onChange([...counters, { number: next, name: '', point_type: 'COUNTER', is_open: true }])
  }

  const update = (index: number, patch: Partial<CounterCreate>) =>
    onChange(counters.map((c, i) => (i === index ? { ...c, ...patch } : c)))

  return (
    <fieldset>
      <legend className="text-ink-3 tracked mb-2 text-[11px] font-medium">Counters</legend>
      <p className="text-ink-3 mb-3 text-xs leading-relaxed">
        Counters can only be added while creating the agency — the API has no route to add one
        afterwards. Without at least one, tickets can be issued but never called.
      </p>

      <div className="space-y-2">
        {counters.map((counter, index) => {
          const clash = duplicates.has(counter.number)
          return (
            <div key={index} className="flex items-start gap-2">
              <input
                type="number"
                min={1}
                aria-label={`Counter ${index + 1} number`}
                aria-invalid={clash || undefined}
                className={`${controlClass(clash)} w-20 shrink-0`}
                value={counter.number}
                onChange={(e) => update(index, { number: Number(e.target.value) })}
              />
              <input
                aria-label={`Counter ${index + 1} name`}
                className={controlClass()}
                placeholder="Guichet 1"
                value={counter.name ?? ''}
                onChange={(e) => update(index, { name: e.target.value })}
              />
              {/* Whether this point serves one visitor at a time (COUNTER) or
                  handles work that does not (OFFICE, e.g. a back-office loan
                  review). Assigning it to a service later can still change
                  this - see PATCH /api/counters/{id}/service. */}
              <select
                aria-label={`Counter ${index + 1} point type`}
                className={`${controlClass()} w-28 shrink-0`}
                value={counter.point_type ?? 'COUNTER'}
                onChange={(e) =>
                  update(index, { point_type: e.target.value as CounterCreate['point_type'] })
                }
              >
                {POINT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label className="text-ink-2 flex h-[42px] shrink-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-accent size-4"
                  checked={counter.is_open ?? true}
                  onChange={(e) => update(index, { is_open: e.target.checked })}
                />
                Open
              </label>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onChange(counters.filter((_, i) => i !== index))}
                aria-label={`Remove counter ${index + 1}`}
                className="h-[42px] shrink-0"
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          )
        })}
      </div>

      {duplicates.size > 0 && (
        <p role="alert" className="text-danger mt-2 text-xs">
          Counter numbers must be unique within the agency.
        </p>
      )}

      <Button type="button" size="sm" onClick={add} className="mt-2">
        <Plus className="size-3.5" aria-hidden />
        Add counter
      </Button>
    </fieldset>
  )
}

/** Zones, same create-only constraint as counters. */
function RepeatableZones({
  zones,
  onChange,
}: {
  zones: ZoneCreate[]
  onChange: (zones: ZoneCreate[]) => void
}) {
  const update = (index: number, patch: Partial<ZoneCreate>) =>
    onChange(zones.map((z, i) => (i === index ? { ...z, ...patch } : z)))

  return (
    <fieldset>
      <legend className="text-ink-3 tracked mb-2 text-[11px] font-medium">Zones</legend>
      <p className="text-ink-3 mb-3 text-xs leading-relaxed">
        Named areas the occupancy counter reports against. Also create-only.
      </p>

      <div className="space-y-2">
        {zones.map((zone, index) => (
          <div key={index} className="flex items-start gap-2">
            <input
              aria-label={`Zone ${index + 1} name`}
              className={controlClass()}
              placeholder="Accueil"
              value={zone.name}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            <input
              aria-label={`Zone ${index + 1} type`}
              className={`${controlClass()} w-32 shrink-0`}
              placeholder="PUBLIC"
              value={zone.zone_type ?? ''}
              onChange={(e) => update(index, { zone_type: e.target.value })}
            />
            <label className="text-ink-2 flex h-[42px] shrink-0 items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="accent-accent size-4"
                checked={zone.is_private ?? false}
                onChange={(e) => update(index, { is_private: e.target.checked })}
              />
              Private
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(zones.filter((_, i) => i !== index))}
              aria-label={`Remove zone ${index + 1}`}
              className="h-[42px] shrink-0"
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        size="sm"
        onClick={() => onChange([...zones, { name: '', zone_type: 'PUBLIC', is_private: false }])}
        className="mt-2"
      >
        <Plus className="size-3.5" aria-hidden />
        Add zone
      </Button>
    </fieldset>
  )
}
