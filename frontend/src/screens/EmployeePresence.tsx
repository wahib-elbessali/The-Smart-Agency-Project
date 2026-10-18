import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertTriangle, DoorOpen, LogIn, RefreshCw, UserCheck, UserPlus } from 'lucide-react'
import { isLate, type AttendanceEntry } from '@/api/attendanceMerge'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchEmployees } from '@/api/endpoints/employees'
import { useAttendanceToday } from '@/hooks/useAttendanceToday'
import { useScope, withinScope } from '@/agency/ScopeContext'
import type { Agency, Employee } from '@/api/types'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { StreamStatusBadge } from '@/components/StreamStatusBadge'
import { BarSeries } from '@/components/charts/BarSeries'
import { Donut } from '@/components/charts/Donut'
import { Sparkline } from '@/components/charts/Sparkline'
import { foldToPalette } from '@/components/charts/palette'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Clock } from '@/components/ui/Time'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { EmployeeHistory } from './EmployeeHistory'
import { RecordAttendance } from './RecordAttendance'
import { arrivalsByHalfHour, busiestIndex, headcountSeries, methodMix } from './presenceSeries'
import { Screen } from './Screen'

/**
 * The one screen contracts/api.md fully supports today.
 *
 * Three endpoints feed it:
 *   GET /api/attendance/today  - who badged in, the snapshot
 *   WS  /ws/attendance         - keeps that current
 *   GET /api/employees         - position and RFID, joined on employee_id
 *   GET /api/agencies          - opening_time, to derive "late"
 *
 * Employees and agencies are secondary: if either fails the table still renders
 * with the attendance data alone, because "who is in the building" is the
 * question this screen exists to answer and a missing job title should not
 * blank it out.
 */

export default function EmployeePresence() {
  const attendance = useAttendanceToday()
  const scope = useScope()

  /**
   * Filtered once, here, and everything downstream follows.
   *
   * The stat tiles, the three charts and the table all derive from this list,
   * so scoping it at the source is what keeps "in the building" and the roster
   * underneath it counting the same people. Filtering in the table alone would
   * leave an admin reading one branch's roster under the whole estate's totals,
   * which is a worse answer than either one on its own.
   */
  const entries = useMemo(
    () => withinScope(attendance.entries, scope.agencyId),
    [attendance.entries, scope.agencyId],
  )

  const employees = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => fetchEmployees(signal),
  })

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
  })

  const employeeById = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const employee of employees.data ?? []) map.set(employee.id, employee)
    return map
  }, [employees.data])

  const agencyById = useMemo(() => {
    const map = new Map<string, Agency>()
    for (const agency of agencies.data ?? []) map.set(agency.id, agency)
    return map
  }, [agencies.data])

  const lateCount = useMemo(
    () =>
      entries.filter(
        (entry) => isLate(entry.check_in, agencyById.get(entry.agency_id)?.opening_time) === true,
      ).length,
    [entries, agencyById],
  )

  const knowsOpeningTime = agencyById.size > 0

  const [recording, setRecording] = useState(false)
  /* The employee whose history is open, or null. Held as the row rather than
     just an id so the dialog can title itself without a second lookup. */
  const [viewing, setViewing] = useState<AttendanceEntry | null>(null)

  const arrivals = useMemo(() => arrivalsByHalfHour(entries), [entries])
  const headcount = useMemo(() => headcountSeries(entries), [entries])
  const methods = useMemo(() => foldToPalette(methodMix(entries)), [entries])

  return (
    <Screen
      title="Employee presence"
      description="Who is in the building right now, from badge and reader events."
      actions={
        <>
          <StreamStatusBadge status={attendance.streamStatus} />
          <Button size="sm" onClick={attendance.refetch} aria-label="Refresh attendance">
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh
          </Button>
          {/* Attendance otherwise only arrives from the RFID readers over MQTT,
              so somebody who forgot their badge cannot be recorded at all. */}
          <Button variant="primary" size="sm" onClick={() => setRecording(true)}>
            <UserPlus className="size-3.5" aria-hidden />
            Record attendance
          </Button>
        </>
      }
    >
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="In the building"
          value={attendance.totals.present}
          tone="ok"
          icon={<UserCheck className="size-4" aria-hidden />}
          /* Headcount through the day, not a period-over-period trend. It is
             the one shape today's snapshot can honestly draw, and it answers
             the question the number leaves open: is this the peak, or is the
             building still filling up? */
          detail={
            headcount.length > 1 ? (
              <Sparkline values={headcount} tone="ok" width={110} height={26} />
            ) : undefined
          }
          hint="Checked in, no check-out yet"
        />
        <StatTile
          label="Checked out"
          value={attendance.totals.departed}
          icon={<DoorOpen className="size-4" aria-hidden />}
          hint="Completed visits today"
        />
        <StatTile
          label="Late arrivals"
          value={knowsOpeningTime ? lateCount : '—'}
          tone={lateCount > 0 ? 'warn' : 'neutral'}
          icon={<LogIn className="size-4" aria-hidden />}
          /* A share, not a percentage change. "4" means nothing without the
             denominator - four late out of five arrivals is a different morning
             from four out of forty. Both numbers are in the snapshot. */
          detail={
            knowsOpeningTime && attendance.totals.total > 0 ? (
              <p className="text-ink-3 text-xs">
                of <span className="tabular">{attendance.totals.total}</span> arrivals today
              </p>
            ) : undefined
          }
          hint={
            knowsOpeningTime
              ? 'Checked in after the agency opening time'
              : 'Needs the agency opening time'
          }
        />
      </div>

      {/* The two charts sit between the headline figures and the roster, which
          is the order the questions get asked in: how many, then what shape was
          the morning, then who exactly. Both are derived from the same snapshot
          the table below renders - no extra request, and nothing on screen can
          disagree with anything else on screen. */}
      {arrivals.length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-5">
          <Panel as="section" className="lg:col-span-3">
            <PanelHeader>
              <h2 className="text-ink text-sm font-semibold">Arrivals through the day</h2>
              <p className="text-ink-3 mt-1 text-xs">
                Check-ins per half hour. The busiest period is highlighted.
              </p>
            </PanelHeader>
            <PanelBody>
              <BarSeries
                data={arrivals}
                litIndex={busiestIndex(arrivals)}
                format={(n) => `${n} ${n === 1 ? 'arrival' : 'arrivals'}`}
                height={150}
              />
            </PanelBody>
          </Panel>

          <Panel as="section" className="lg:col-span-2">
            <PanelHeader>
              <h2 className="text-ink text-sm font-semibold">How people badged in</h2>
              <p className="text-ink-3 mt-1 text-xs">Reader method for today&rsquo;s check-ins.</p>
            </PanelHeader>
            <PanelBody>
              <Donut
                segments={methods}
                totalLabel="check-ins"
                size={148}
                className="justify-center"
              />
            </PanelBody>
          </Panel>
        </div>
      )}

      {attendance.isStale && !attendance.isPending && !attendance.error && <StaleNotice />}

      <AsyncBoundary
        isPending={attendance.isPending}
        error={attendance.error}
        isEmpty={entries.length === 0}
        emptyMessage="Nobody has checked in today yet."
        /* GET /api/attendance/today is restricted to ADMIN, MANAGER and
           SECURITY, so AGENT and TECHNICIAN land here. Naming the roles saves
           a round trip to whoever administers accounts. */
        forbiddenMessage="Attendance is visible to administrators, managers and security staff. Ask an administrator if you need access."
        onRetry={attendance.refetch}
        skeletonRows={6}
      >
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-ink text-sm font-semibold">Today</h2>
              <span className="text-ink-3 tabular text-xs">
                {attendance.totals.total} {attendance.totals.total === 1 ? 'record' : 'records'}
              </span>
            </div>
          </PanelHeader>
          <PanelBody flush>
            <RosterTable
              entries={entries}
              employeeById={employeeById}
              agencyById={agencyById}
              onSelect={setViewing}
            />
          </PanelBody>
        </Panel>
      </AsyncBoundary>

      <Dialog
        open={recording}
        title="Record attendance"
        description="Stands in for a badge reader, for anyone who arrived without their card."
        onClose={() => setRecording(false)}
      >
        {recording && <RecordAttendance onDone={() => setRecording(false)} />}
      </Dialog>

      <Dialog
        open={viewing !== null}
        title={viewing ? viewing.employee_name : ''}
        description="Attendance history, most recent first."
        onClose={() => setViewing(null)}
      >
        {viewing && (
          <EmployeeHistory
            employeeId={viewing.employee_id}
            openingTime={agencyById.get(viewing.agency_id)?.opening_time}
          />
        )}
      </Dialog>
    </Screen>
  )
}

/**
 * Shown whenever the snapshot loaded but the socket is not open.
 *
 * This is the whole reason StreamStatus exists. A table of people who checked in
 * two hours ago looks exactly like a live one - same rows, same times, nothing
 * moving because nothing is happening. Saying so explicitly is the difference
 * between "quiet morning" and "the feed died at 09:10 and nobody noticed".
 */
function StaleNotice() {
  return (
    <Panel tone="alert" className="mb-6">
      <PanelBody className="flex gap-3 py-4">
        <AlertTriangle className="text-warn mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-warn/90 text-sm leading-relaxed" role="status">
          <span className="font-medium">Not receiving live updates.</span> These rows are from the
          last load and will not change until the connection comes back.
        </p>
      </PanelBody>
    </Panel>
  )
}

function RosterTable({
  entries,
  employeeById,
  agencyById,
  onSelect,
}: {
  entries: AttendanceEntry[]
  employeeById: Map<string, Employee>
  agencyById: Map<string, Agency>
  onSelect: (entry: AttendanceEntry) => void
}) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Employees who have checked in today, still-present first
        </caption>
        <thead>
          <tr className="text-ink-3 tracked border-line/70 border-b text-left text-[10px] font-medium">
            <th scope="col" className="px-6 py-3 font-medium">
              Employee
            </th>
            <th scope="col" className="px-6 py-3 font-medium">
              Position
            </th>
            <th scope="col" className="px-6 py-3 font-medium">
              In
            </th>
            <th scope="col" className="px-6 py-3 font-medium">
              Out
            </th>
            <th scope="col" className="px-6 py-3 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const employee = employeeById.get(entry.employee_id)
            const late = isLate(entry.check_in, agencyById.get(entry.agency_id)?.opening_time)
            const stillIn = entry.check_out === null

            return (
              <tr
                key={`${entry.employee_id}|${entry.check_in}`}
                className="border-line/70 hover:bg-panel-2/60 ease-soft border-b transition-colors duration-150 last:border-b-0"
              >
                <th scope="row" className="px-6 py-3 text-left font-normal">
                  {/* A button, not a row click: the history is a real
                      navigation and has to be reachable from the keyboard.
                      Wrapping the whole row instead would swallow any future
                      control inside it. */}
                  <button
                    type="button"
                    onClick={() => onSelect(entry)}
                    className="ease-soft flex w-full items-center gap-3 text-left transition-opacity duration-150 hover:opacity-80"
                    aria-label={`Attendance history for ${entry.employee_name}`}
                  >
                    <Avatar name={entry.employee_name} />
                    <div className="min-w-0">
                      <div className="text-ink truncate font-medium">{entry.employee_name}</div>
                      {employee?.rfid_uid && (
                        <div className="text-ink-3 truncate font-mono text-xs">
                          {employee.rfid_uid}
                        </div>
                      )}
                    </div>
                  </button>
                </th>
                <td className="text-ink-2 px-6 py-3">
                  {/* Two different unknowns, deliberately worded differently.
                      Attendance can name someone the employees list doesn't
                      cover, because a MANAGER's scope is set by the backend and
                      the two calls are not guaranteed to agree. Separately,
                      `position` is nullable in EmployeeResponse, so a known
                      employee can simply not have one. Neither may render as a
                      blank cell - on a wall display that reads as a bug. */}
                  {!employee ? (
                    <span className="text-ink-3">Not in employee list</span>
                  ) : employee.position ? (
                    employee.position
                  ) : (
                    <span className="text-ink-3">No position set</span>
                  )}
                </td>
                <td className="text-ink-2 px-6 py-3">
                  <Clock iso={entry.check_in} />
                </td>
                <td className="text-ink-2 px-6 py-3">
                  <Clock iso={entry.check_out} />
                </td>
                <td className="px-6 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {stillIn ? <Badge tone="ok">In</Badge> : <Badge tone="neutral">Out</Badge>}
                    {late === true && <Badge tone="warn">Late</Badge>}
                    <Badge tone="neutral">{entry.method}</Badge>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
