import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LogIn, LogOut } from 'lucide-react'
import { checkIn, checkOut } from '@/api/endpoints/attendance'
import { ApiError, describeApiError } from '@/api/errors'
import type { AttendanceRecord } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Clock } from '@/components/ui/Time'

/**
 * Records an arrival or a departure by card number, standing in for a reader.
 *
 * This exists because attendance otherwise only arrives over MQTT from the RFID
 * readers: somebody who forgets their badge simply does not appear on the
 * presence screen all day, and there is no way to correct that from the
 * interface. These two routes are the correction.
 *
 * THE CHECK-IN ROUTE DOES NOT REFUSE A DOUBLE CHECK-IN. If the employee already
 * has an open record the backend returns THAT record, with a 200, having
 * created nothing. Reporting "checked in" on any 200 would therefore tell
 * someone they were checked in a moment ago when the record says 08:12.
 *
 * HOW WE TELL THE TWO APART - two signals, because neither is sufficient alone.
 *
 * 1. THE RECORD ID. Every id this form has successfully created is remembered
 *    for the life of the dialog. Getting one of them back is proof the backend
 *    returned an existing record rather than making a new one. Exact, and
 *    immune to how close together the two attempts happen.
 * 2. THE ECHOED TIMESTAMP. The request sends an explicit `timestamp` - the
 *    contract accepts one and defaults to now when omitted - so a record the
 *    backend just created echoes it back. This is what catches the ordinary
 *    case: a record opened at 08:12 that this dialog never saw, because the
 *    page has been reloaded or somebody else scanned the card.
 *
 * Time alone is not enough, which is worth stating because it is the obvious
 * implementation and it is wrong: two check-ins a second apart both look
 * "recent", so the second is reported as a fresh arrival. The id catches that.
 * The id alone is not enough either - it knows nothing about records created
 * before this dialog opened. Together they cover both.
 */

/**
 * Tolerance when matching the echoed timestamp, in milliseconds.
 *
 * Not zero: a backend is free to normalise the format - drop milliseconds,
 * shift the zone - and an exact compare would then read every check-in as
 * pre-existing. Generous, because the id check above is what handles the
 * near-simultaneous case this cannot.
 */
const ECHO_TOLERANCE_MS = 2000

type Outcome =
  | { kind: 'checked-in'; record: AttendanceRecord }
  | { kind: 'already-in'; record: AttendanceRecord }
  | { kind: 'checked-out'; record: AttendanceRecord }

function markErrorMessage(error: unknown, mode: 'in' | 'out'): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not record that.'

  switch (error.status) {
    case 404:
      return 'No active employee holds that card. Check the number, and that the employee is ACTIVE.'
    case 409:
      return mode === 'out'
        ? 'That employee has no open check-in, so there is nothing to close.'
        : describeApiError(error)
    case 403:
      return 'That employee belongs to another agency.'
    default:
      return describeApiError(error)
  }
}

export function RecordAttendance({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [rfid, setRfid] = useState('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /* Ids this dialog has successfully created. A ref, not state: it is evidence
     for the next request, and nothing renders from it. */
  const createdIds = useRef(new Set<string>())

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['attendance'] })
  }

  const mark = useMutation({
    mutationFn: async ({ mode }: { mode: 'in' | 'out' }) => {
      const employee_rfid = rfid.trim()

      if (mode === 'out') {
        return { kind: 'checked-out' as const, record: await checkOut({ employee_rfid }) }
      }

      /* Send the time explicitly so the reply can be matched against it. The
         200 alone means nothing - see the note at the top of this file. */
      const timestamp = new Date().toISOString()
      const record = await checkIn({ employee_rfid, timestamp })

      const seenBefore = createdIds.current.has(record.id)
      const drift = Math.abs(new Date(record.check_in).getTime() - new Date(timestamp).getTime())

      if (seenBefore || drift > ECHO_TOLERANCE_MS) {
        return { kind: 'already-in' as const, record }
      }

      createdIds.current.add(record.id)
      return { kind: 'checked-in' as const, record }
    },
    onSuccess: async (result) => {
      setOutcome(result)
      setRfid('')
      await invalidate()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
  }

  const disabled = rfid.trim() === '' || mark.isPending
  const serverMessage = markErrorMessage(mark.error, 'out')

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        id="attendance_rfid"
        label="Card number"
        required
        hint="The employee must be ACTIVE and hold this card."
      >
        {(props) => (
          <input
            {...props}
            value={rfid}
            onChange={(e) => {
              setRfid(e.target.value)
              setOutcome(null)
              mark.reset()
            }}
            placeholder="RFID-001"
            autoFocus
          />
        )}
      </Field>

      {outcome && (
        <div
          role="status"
          className="border-ok/30 bg-ok/8 rounded-lg border p-3 text-sm leading-relaxed"
        >
          {outcome.kind === 'checked-in' && (
            <p className="text-ok">
              <span className="font-medium">{outcome.record.employee_name}</span> checked in at{' '}
              <Clock iso={outcome.record.check_in} />.
            </p>
          )}
          {/* The case a naive implementation reports as a fresh check-in. */}
          {outcome.kind === 'already-in' && (
            <p className="text-warn">
              <span className="font-medium">{outcome.record.employee_name}</span> was already inside
              since <Clock iso={outcome.record.check_in} /> — nothing was changed.
            </p>
          )}
          {outcome.kind === 'checked-out' && (
            <p className="text-ok">
              <span className="font-medium">{outcome.record.employee_name}</span> checked out at{' '}
              <Clock iso={outcome.record.check_out} />.
            </p>
          )}
        </div>
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
        <Button type="button" onClick={onDone}>
          Close
        </Button>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => mark.mutate({ mode: 'out' })}
          aria-label="Record check-out"
        >
          <LogOut className="size-3.5" aria-hidden />
          Check out
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={disabled}
          onClick={() => mark.mutate({ mode: 'in' })}
          aria-label="Record check-in"
        >
          <LogIn className="size-3.5" aria-hidden />
          {mark.isPending ? 'Recording…' : 'Check in'}
        </Button>
      </div>
    </form>
  )
}
