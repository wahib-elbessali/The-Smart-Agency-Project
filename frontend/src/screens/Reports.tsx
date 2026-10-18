import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchAgencyReport, fetchBranchRollup } from '@/api/endpoints/reports'
import type { AgencyReport } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { controlClass } from '@/components/ui/control'
import { CountersPanel, DailyPanel, ServicesPanel } from './InsightsTrends'
import { Screen } from './Screen'
import {
  describeRange,
  matchingPreset,
  presetRange,
  todayIso,
  validateRange,
  type DateRange,
  type PresetKey,
} from './reportPeriod'
import { formatDay, formatDuration } from './trendFormat'

/**
 * End-of-month reporting: the historical
 * counterpart of the live Insights screen. The same kinds of measures over a
 * date range someone picks - for one branch (a manager reviewing their own
 * month) or, for an admin, every branch at once with totals.
 *
 * A dashboard view, not an exportable file. It does NOT refresh by itself: a
 * past period does not change while someone is looking at it, so polling would
 * be wasted work (unlike the live branch comparison). A period that reaches
 * today is a snapshot of the moment it was run, and says so.
 *
 * Tickets are the ones TAKEN in the period; how they ended and how long they
 * took are read off that same group, so the numbers add up.
 */

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'last_month', label: 'Last month' },
  { key: 'this_month', label: 'This month so far' },
  { key: 'last_30', label: 'Last 30 days' },
]

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value)}%`)

export default function Reports() {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'

  /* What is being reported on: the range actually applied, and the one being
     typed, which only becomes the applied one when it is valid and submitted. */
  const [range, setRange] = useState<DateRange>(() => presetRange('last_month'))
  const [draft, setDraft] = useState<DateRange>(range)
  const problem = validateRange(draft)

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  const picker = (
    <Panel as="section" className="mb-4">
      <PanelBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.key}
              size="sm"
              variant={matchingPreset(range) === preset.key ? 'primary' : 'secondary'}
              onClick={() => {
                const next = presetRange(preset.key)
                setRange(next)
                setDraft(next)
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!problem) setRange(draft)
          }}
        >
          <label className="text-ink-2 text-xs">
            From
            <input
              type="date"
              className={`${controlClass()} mt-1 block`}
              value={draft.start}
              max={todayIso()}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            />
          </label>
          <label className="text-ink-2 text-xs">
            To
            <input
              type="date"
              className={`${controlClass()} mt-1 block`}
              value={draft.end}
              max={todayIso()}
              onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            />
          </label>
          <Button size="sm" type="submit" disabled={problem !== null}>
            Show report
          </Button>
        </form>
        {problem && (
          <p role="alert" className="text-warn text-xs">
            {problem}
          </p>
        )}
        <p className="text-ink-3 text-xs">Showing {describeRange(range)}. Days are UTC.</p>
      </PanelBody>
    </Panel>
  )

  if (!isAdmin) {
    return (
      <Screen title="Reports" description="Your branch over a period you choose.">
        {picker}
        {user?.agency_id ? <BranchReport agencyId={user.agency_id} range={range} /> : null}
      </Screen>
    )
  }

  const rows = agencies.data ?? []
  const focused =
    rows.find((agency) => agency.id === scope.agencyId) ?? (rows.length === 1 ? rows[0] : null)

  return (
    <Screen title="Reports" description="Every branch, or one, over a period you choose.">
      {picker}
      <AsyncBoundary
        isPending={agencies.isPending}
        error={agencies.error}
        isEmpty={rows.length === 0}
        emptyMessage="No branches yet, so there is nothing to report on."
        onRetry={() => void agencies.refetch()}
        skeletonRows={4}
      >
        {focused ? <BranchReport agencyId={focused.id} range={range} /> : <Rollup range={range} />}
      </AsyncBoundary>
    </Screen>
  )
}

function Generated({ report }: { report: AgencyReport }) {
  const reachesToday = report.period.end === todayIso()
  return (
    <p className="text-ink-3 text-xs leading-relaxed">
      Run{' '}
      {new Date(report.generated_at).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}
      .
      {reachesToday
        ? ' This period reaches today, so it is a snapshot - show the report again to refresh it.'
        : ' This period is over, so it will not change.'}
    </p>
  )
}

function BranchReport({ agencyId, range }: { agencyId: string; range: DateRange }) {
  const report = useQuery({
    queryKey: ['report', agencyId, range.start, range.end],
    queryFn: ({ signal }) => fetchAgencyReport(agencyId, range.start, range.end, signal),
    /* No polling, and no refetch on focus: it is a report, not a live view. */
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  return (
    <AsyncBoundary
      isPending={report.isPending}
      error={report.error}
      forbiddenMessage="Reports are read by administrators and by managers of their own branch."
      onRetry={() => void report.refetch()}
      skeletonRows={5}
    >
      {report.data && <ReportBody report={report.data} />}
    </AsyncBoundary>
  )
}

function ReportBody({ report }: { report: AgencyReport }) {
  const { tickets, wait_times, satisfaction, service_satisfaction, alerts, busiest, trends } =
    report
  const typeEntries = Object.entries(alerts.opened_by_type)

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-ink text-sm font-semibold">
          {report.name} · {describeRange(report.period)}
        </h2>
        <Generated report={report} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Tickets taken" value={tickets.created} />
        <StatTile
          label="Completed"
          value={pct(tickets.completion_pct)}
          hint={`${tickets.completed} tickets`}
        />
        <StatTile label="Avg wait" value={formatDuration(wait_times.avg_queue_wait_seconds)} />
        <StatTile
          label="Avg service"
          value={formatDuration(wait_times.avg_service_duration_seconds)}
        />
        <StatTile label="Alerts opened" value={alerts.opened_total} />
        <StatTile
          label="Negative mood"
          value={pct(satisfaction.negative_pct)}
          hint={`${satisfaction.total_samples} samples`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel as="section">
          <PanelHeader>
            <h3 className="text-ink text-sm font-semibold">How the tickets ended</h3>
            <p className="text-ink-3 mt-1 text-xs">Tickets taken in the period.</p>
          </PanelHeader>
          <PanelBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Fact label="Taken" value={tickets.created} />
              <Fact label="Completed" value={tickets.completed} />
              <Fact label="Cancelled" value={tickets.cancelled} />
              <Fact label="No-show" value={tickets.no_show} />
              <Fact label="Still open" value={tickets.unfinished} />
              <Fact label="Visitors served" value={tickets.visitors_served} />
            </dl>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <h3 className="text-ink text-sm font-semibold">How long it took</h3>
            <p className="text-ink-3 mt-1 text-xs">
              Averages over those tickets. A ticket that never reached a step is left out of that
              step, not counted as zero.
            </p>
          </PanelHeader>
          <PanelBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact
                label="Wait in the queue"
                value={formatDuration(wait_times.avg_queue_wait_seconds)}
              />
              <Fact
                label="Walk to the counter"
                value={formatDuration(wait_times.avg_walk_over_seconds)}
              />
              <Fact
                label="At the counter"
                value={formatDuration(wait_times.avg_service_duration_seconds)}
              />
              <Fact label="Door to door" value={formatDuration(wait_times.avg_total_seconds)} />
            </dl>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <h3 className="text-ink text-sm font-semibold">Customer mood</h3>
            <p className="text-ink-3 mt-1 text-xs">
              Share of expressions seen; a small sample is a thin reading.
            </p>
          </PanelHeader>
          <PanelBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact label="Positive" value={pct(satisfaction.positive_pct)} />
              <Fact label="Negative" value={pct(satisfaction.negative_pct)} />
              <Fact label="Samples" value={satisfaction.total_samples} />
              <Fact
                label="Negative at the counter"
                value={pct(service_satisfaction.negative_pct)}
                hint={
                  service_satisfaction.tickets_with_coverage === 0
                    ? 'no counter has a camera linked'
                    : `${service_satisfaction.total_samples} samples`
                }
              />
            </dl>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <h3 className="text-ink text-sm font-semibold">Alerts</h3>
            <p className="text-ink-3 mt-1 text-xs">Opened during the period.</p>
          </PanelHeader>
          <PanelBody className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact label="Opened" value={alerts.opened_total} />
              <Fact label="Resolved" value={alerts.resolved} />
              <Fact label="Critical" value={alerts.opened_by_severity.CRITICAL ?? 0} />
              <Fact
                label="Typical time to resolve"
                value={
                  alerts.avg_resolve_minutes === null
                    ? '—'
                    : `${Math.round(alerts.avg_resolve_minutes)} min`
                }
              />
            </dl>
            {typeEntries.length > 0 && (
              <p className="flex flex-wrap gap-1.5">
                {typeEntries.map(([type, count]) => (
                  <Badge key={type} tone="neutral">
                    {type} · {count}
                  </Badge>
                ))}
              </p>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel as="section">
        <PanelHeader>
          <h3 className="text-ink text-sm font-semibold">Busiest</h3>
          <p className="text-ink-3 mt-1 text-xs">By tickets taken. Hours are UTC.</p>
        </PanelHeader>
        <PanelBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Fact
              label="Busiest day"
              value={busiest.day ? formatDay(busiest.day) : '—'}
              hint={busiest.day ? `${busiest.day_tickets} tickets` : undefined}
            />
            <Fact
              label="Busiest hour"
              value={
                busiest.hour_utc === null ? '—' : `${String(busiest.hour_utc).padStart(2, '0')}:00`
              }
              hint={busiest.hour_utc === null ? undefined : `${busiest.hour_tickets} tickets`}
            />
          </dl>
        </PanelBody>
      </Panel>

      {trends && (
        <>
          <DailyPanel daily={trends.daily} />
          <div className="grid gap-3 lg:grid-cols-2">
            <CountersPanel
              counters={trends.counters}
              openingSeconds={trends.opening_seconds_per_day}
            />
            <ServicesPanel services={trends.services} />
          </div>
        </>
      )}
    </div>
  )
}

function Fact({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <dt className="text-ink-3 tracked text-[10px] font-medium">{label}</dt>
      <dd className="text-ink tabular text-lg font-semibold">{value}</dd>
      {hint && <p className="text-ink-3 text-xs">{hint}</p>}
    </div>
  )
}

function Rollup({ range }: { range: DateRange }) {
  const scope = useScope()
  const rollup = useQuery({
    queryKey: ['report-rollup', range.start, range.end],
    queryFn: ({ signal }) => fetchBranchRollup(range.start, range.end, signal),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const data = rollup.data

  const lines = useMemo(
    () =>
      data
        ? [
            ...data.branches.map((b) => ({ report: b, total: false })),
            { report: data.totals, total: true },
          ]
        : [],
    [data],
  )

  return (
    <AsyncBoundary
      isPending={rollup.isPending}
      error={rollup.error}
      forbiddenMessage="The all-branches report is for administrators."
      onRetry={() => void rollup.refetch()}
      skeletonRows={4}
    >
      {data && (
        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">
              All branches · {describeRange(data.period)}
            </h2>
            <Generated report={data.totals} />
          </PanelHeader>
          <PanelBody className="overflow-x-auto p-0">
            <RollupTable
              lines={lines}
              onOpen={(report) => scope.enter({ id: report.agency_id, name: report.name })}
            />
          </PanelBody>
          <PanelBody>
            <p className="text-ink-3 text-xs leading-relaxed">
              The totals row is worked out from every branch&apos;s tickets together, not by
              averaging the rows above it, so a quiet branch cannot pull an average around. Open a
              branch for its day-by-day detail.
            </p>
          </PanelBody>
        </Panel>
      )}
    </AsyncBoundary>
  )
}

function RollupTable({
  lines,
  onOpen,
}: {
  lines: { report: AgencyReport; total: boolean }[]
  onOpen: (report: AgencyReport) => void
}) {
  const heads = [
    'Branch',
    'Taken',
    'Completed',
    'Done %',
    'Cancelled',
    'No-show',
    'Avg wait',
    'Avg service',
    'Alerts',
    'Critical',
    'Negative mood',
  ]
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-ink-3 border-line border-b text-left text-xs">
          {heads.map((head) => (
            <th key={head} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map(({ report, total }) => (
          <tr
            key={report.agency_id}
            className={`border-line/60 border-b last:border-0 ${total ? 'bg-panel-2 font-semibold' : ''}`}
          >
            <th scope="row" className="px-3 py-2 text-left whitespace-nowrap">
              {total ? (
                <span className="text-ink">{report.name}</span>
              ) : (
                <button
                  type="button"
                  title={`Open ${report.name}`}
                  onClick={() => onOpen(report)}
                  className="text-ink hover:text-accent font-medium underline-offset-2 hover:underline"
                >
                  {report.name}
                </button>
              )}
            </th>
            <td className="text-ink-2 tabular px-3 py-2">{report.tickets.created}</td>
            <td className="text-ink-2 tabular px-3 py-2">{report.tickets.completed}</td>
            <td className="text-ink-2 tabular px-3 py-2">{pct(report.tickets.completion_pct)}</td>
            <td className="text-ink-2 tabular px-3 py-2">{report.tickets.cancelled}</td>
            <td className="text-ink-2 tabular px-3 py-2">{report.tickets.no_show}</td>
            <td className="text-ink-2 tabular px-3 py-2">
              {formatDuration(report.wait_times.avg_queue_wait_seconds)}
            </td>
            <td className="text-ink-2 tabular px-3 py-2">
              {formatDuration(report.wait_times.avg_service_duration_seconds)}
            </td>
            <td className="text-ink-2 tabular px-3 py-2">{report.alerts.opened_total}</td>
            <td className="text-ink-2 tabular px-3 py-2">
              {report.alerts.opened_by_severity.CRITICAL ?? 0}
            </td>
            <td className="text-ink-2 tabular px-3 py-2">
              {pct(report.satisfaction.negative_pct)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
