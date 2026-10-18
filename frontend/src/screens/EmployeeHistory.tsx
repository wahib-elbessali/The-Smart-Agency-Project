import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchEmployeeAttendance } from '@/api/endpoints/attendance'
import { isLate } from '@/api/attendanceMerge'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Clock } from '@/components/ui/Time'
import { Sparkline } from '@/components/charts/Sparkline'

/**
 * One employee's attendance history.
 *
 * The contract's only historical attendance route, so this is the sole place
 * anything longer than today can be shown. The hours-per-day sparkline is the
 * first trend in this application that is not fabricated - everything else has
 * had to work from GET /api/attendance/today alone.
 *
 * Records with no check_out contribute no duration: an open record is somebody
 * still inside, not a zero-hour day, and averaging it in as zero would drag the
 * figure down for exactly the people currently at work.
 */

function hoursOf(checkIn: string, checkOut: string | null): number | null {
  if (!checkOut) return null
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms / 3_600_000
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function EmployeeHistory({
  employeeId,
  openingTime,
}: {
  employeeId: string
  /** From the employee's agency, to derive "late". Absent when unknown. */
  openingTime?: string | null
}) {
  const history = useQuery({
    queryKey: ['attendance', 'employee', employeeId],
    queryFn: ({ signal }) => fetchEmployeeAttendance(employeeId, signal),
  })

  const rows = useMemo(() => history.data ?? [], [history.data])

  const summary = useMemo(() => {
    const durations = rows
      .map((r) => hoursOf(r.check_in, r.check_out))
      .filter((h): h is number => h !== null)
    const lateCount = rows.filter(
      (r) => isLate(r.check_in, openingTime ?? undefined) === true,
    ).length
    const average = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null
    /* Oldest first for the sparkline - a trend read right to left is a trap. */
    return { average, lateCount, series: [...durations].reverse() }
  }, [rows, openingTime])

  return (
    <AsyncBoundary
      isPending={history.isPending}
      error={history.error}
      isEmpty={rows.length === 0}
      emptyMessage="No attendance recorded for this employee yet."
      forbiddenMessage="Attendance is visible to administrators, managers and security staff."
      onRetry={() => void history.refetch()}
      skeletonRows={4}
    >
      <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-ink-3 tracked text-[10px] font-medium">Average day</div>
          <div className="text-ink tabular mt-1 text-lg font-bold">
            {summary.average === null ? '—' : `${summary.average.toFixed(1)} h`}
          </div>
        </div>
        <div>
          <div className="text-ink-3 tracked text-[10px] font-medium">Late arrivals</div>
          <div className="text-ink tabular mt-1 text-lg font-bold">
            {openingTime ? summary.lateCount : '—'}
          </div>
        </div>
        {summary.series.length > 1 && (
          <div className="ml-auto">
            <div className="text-ink-3 tracked mb-1 text-[10px] font-medium">Hours per day</div>
            <Sparkline values={summary.series} tone="accent" width={130} height={28} />
          </div>
        )}
      </div>

      <div className="relative max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Attendance history, most recent first</caption>
          <thead>
            <tr className="text-ink-3 tracked border-line/70 sticky top-0 border-b text-left text-[10px] font-medium">
              <th scope="col" className="bg-panel py-2 pr-4 font-medium">
                Day
              </th>
              <th scope="col" className="bg-panel py-2 pr-4 font-medium">
                In
              </th>
              <th scope="col" className="bg-panel py-2 pr-4 font-medium">
                Out
              </th>
              <th scope="col" className="bg-panel py-2 font-medium">
                Hours
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => {
              const hours = hoursOf(record.check_in, record.check_out)
              const late = isLate(record.check_in, openingTime ?? undefined)
              return (
                <tr key={record.id} className="border-line/70 border-b last:border-b-0">
                  <th scope="row" className="text-ink py-3 pr-4 text-left font-normal">
                    <span className="flex items-center gap-2">
                      {dayLabel(record.check_in)}
                      {late === true && <Badge tone="warn">Late</Badge>}
                    </span>
                  </th>
                  <td className="text-ink-2 py-3 pr-4">
                    <Clock iso={record.check_in} />
                  </td>
                  <td className="text-ink-2 py-3 pr-4">
                    {record.check_out ? (
                      <Clock iso={record.check_out} />
                    ) : (
                      /* Still inside - not a missing value. */
                      <span className="text-ok">Still in</span>
                    )}
                  </td>
                  <td className="text-ink-2 tabular py-3">
                    {hours === null ? '—' : `${hours.toFixed(1)} h`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </AsyncBoundary>
  )
}
