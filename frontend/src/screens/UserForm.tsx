import { useState, type FormEvent } from 'react'
import { type Agency, type Role, type UserAccount, type UserCreate } from '@/api/types'
import { ASSIGNABLE_ROLES } from '@/auth/access'
import type { Employee } from '@/api/types'
import { ApiError, describeApiError } from '@/api/errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/**
 * Create / edit form for one account.
 *
 * Two things make this different from EmployeeForm.
 *
 * First, this form cannot make an admin. ADMIN is absent from the role picker
 * because nobody is made an admin from this application (auth/access.ts), and
 * with it goes the awkward case this form used to be shaped around: the agency
 * rule is inverted for ADMIN - it must have NO agency where every other role
 * must have one - so the picker had to disappear and explain itself. Every role
 * it can now assign needs an agency, which is the intuitive rule and the only
 * one left to implement. The API still accepts role=ADMIN; this form does not
 * offer it.
 *
 * Second, editing is genuinely narrower than creating. PUT /api/users/{id}
 * accepts no role and no agency; both move through their own PATCH routes,
 * which the table offers inline. So in edit mode those two controls are gone.
 * A form that showed them and silently dropped them would be lying.
 */

export interface UserFormValues {
  full_name: string
  email: string
  password: string
  role: Role
  agency_id: string
  employee_id: string
}

function initialValues(user: UserAccount | null): UserFormValues {
  return {
    full_name: user?.full_name ?? '',
    email: user?.email ?? '',
    /* Never prefilled. On edit an empty box means "leave the password alone",
       which is why it is omitted from the payload rather than sent as "". */
    password: '',
    role: user?.role ?? 'AGENT',
    agency_id: user?.agency_id ?? '',
    employee_id: user?.employee_id ?? '',
  }
}

/** From UserCreate: full_name min 2, email min 5, password 8..72. */
const MIN_NAME = 2
const MIN_EMAIL = 5
const MIN_PASSWORD = 8
const MAX_PASSWORD = 72

function nameError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < MIN_NAME) return `At least ${MIN_NAME} characters.`
  return undefined
}

function emailError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length < MIN_EMAIL) return `At least ${MIN_EMAIL} characters.`
  return undefined
}

/**
 * Optional on edit, required on create - and only ever checked for length.
 *
 * The backend has no complexity rule beyond 8..72, so inventing one here would
 * reject passwords the API accepts. Max 72 is not arbitrary either: it is
 * bcrypt's input limit, and characters past it are silently ignored rather than
 * rejected, which is the kind of thing worth catching in the form.
 */
function passwordError(value: string, required: boolean, touched: boolean): string | undefined {
  if (!touched) return undefined
  if (value === '') return required ? 'Required.' : undefined
  if (value.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters.`
  if (value.length > MAX_PASSWORD) return `At most ${MAX_PASSWORD} characters.`
  return undefined
}

/**
 * Turns a refusal into something actionable. Each maps a `detail` string
 * verified in backend/app/api/users.py, all of which are French:
 *   409 "Cette adresse email existe deja" / "Cet employe est deja lie a un compte"
 *   422 "Un ADMIN est global et ne doit pas avoir d agence"
 *   422 "L employe et l utilisateur doivent appartenir a la meme agence"
 *   404 "Agence introuvable" / "Employe introuvable"
 */
function saveErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not save.'

  switch (error.status) {
    case 409:
      return 'That email is already in use, or that employee already has an account.'
    case 422:
      return 'The server rejected this combination. An admin must have no agency; every other role needs one, and a linked employee must be in the same agency.'
    case 404:
      return 'That agency or employee no longer exists. Pick another one.'
    default:
      return describeApiError(error)
  }
}

export function UserForm({
  user,
  agencies,
  employees,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  /** null when creating. */
  user: UserAccount | null
  agencies: Agency[]
  /** For the optional employee link. Already scoped by the backend. */
  employees: Employee[]
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: UserCreate) => void
}) {
  const [values, setValues] = useState(() => initialValues(user))
  const [touched, setTouched] = useState(false)

  const editing = user !== null

  const fullNameError = nameError(values.full_name, touched)
  const mailError = emailError(values.email, touched)
  const passError = passwordError(values.password, !editing, touched)
  /* Required for every role this form can assign. ADMIN - the one role that
     must NOT have an agency - is not among them (auth/access.ts). */
  const agencyError = !editing && touched && values.agency_id === '' ? 'Required.' : undefined

  const invalid =
    nameError(values.full_name, true) !== undefined ||
    emailError(values.email, true) !== undefined ||
    passwordError(values.password, !editing, true) !== undefined ||
    (!editing && values.agency_id === '')

  const set = <K extends keyof UserFormValues>(key: K, value: UserFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  /* Employees outside the chosen agency cannot be linked (422), so they are not
     offered. On create with no agency chosen yet the list stays empty rather
     than showing options that would all fail. */
  const linkable = employees.filter(
    (employee) => values.agency_id !== '' && employee.agency_id === values.agency_id,
  )

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (invalid) return

    onSubmit({
      full_name: values.full_name.trim(),
      email: values.email.trim(),
      password: values.password,
      role: values.role,
      agency_id: values.agency_id,
      employee_id: values.employee_id === '' ? null : values.employee_id,
    })
  }

  const serverMessage = saveErrorMessage(error)

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="full_name" label="Full name" required error={fullNameError}>
        {(props) => (
          <input
            {...props}
            value={values.full_name}
            onChange={(e) => set('full_name', e.target.value)}
          />
        )}
      </Field>

      <Field
        id="email"
        label="Email"
        required
        hint="This is what they sign in with."
        error={mailError}
      >
        {(props) => (
          <input
            {...props}
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
          />
        )}
      </Field>

      <Field
        id="password"
        label={editing ? 'New password' : 'Password'}
        required={!editing}
        hint={
          editing
            ? 'Leave blank to keep the current password.'
            : `At least ${MIN_PASSWORD} characters. They cannot change it themselves yet.`
        }
        error={passError}
      >
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(e) => set('password', e.target.value)}
          />
        )}
      </Field>

      {/* Role and agency exist on create only: PUT /api/users/{id} accepts
          neither, and the table changes them one call at a time. */}
      {!editing && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="role" label="Role" required>
            {(props) => (
              <select
                {...props}
                value={values.role}
                onChange={(e) =>
                  setValues((current) => ({ ...current, role: e.target.value as Role }))
                }
              >
                {/* ADMIN is not on offer. Nobody is made an admin from this
                    application (auth/access.ts), so the whole inverted-agency
                    branch this form used to carry - hide the picker, explain
                    why, send an explicit null - is gone with it. The rule is
                    still true of the API; it just cannot be reached from here,
                    and a form that handled a case it can never see would be
                    describing an application that does not exist. */}
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field id="agency_id" label="Agency" required error={agencyError}>
            {(props) => (
              <select
                {...props}
                value={values.agency_id}
                onChange={(e) =>
                  setValues((current) => ({
                    ...current,
                    agency_id: e.target.value,
                    /* A link only holds inside one agency, so moving the
                       agency drops it rather than sending a 422. */
                    employee_id: '',
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
        </div>
      )}

      <Field
        id="employee_id"
        label="Linked employee"
        hint="Optional. Connects this login to the person with the card, in the same agency."
      >
        {(props) => (
          <select
            {...props}
            value={values.employee_id}
            onChange={(e) => set('employee_id', e.target.value)}
            disabled={values.agency_id === ''}
          >
            <option value="">Not linked</option>
            {linkable.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.first_name} {employee.last_name}
              </option>
            ))}
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
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create account'}
        </Button>
      </div>
    </form>
  )
}
