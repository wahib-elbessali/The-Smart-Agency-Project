import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchInsightsTrends } from '@/api/endpoints/insights'
import type { CounterPerformance, ServicePerformance, TrendDay } from '@/api/types'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { DeviceUptimePanel } from './DeviceUptimePanel'
import { formatDay, formatDuration, sortServices } from './trendFormat'

/**
 * History, for the decisions a manager actually makes (scenario-planning
 * backlog, "Busy Monday morning"): is a counter carrying its weight, which
 * service is the bottleneck, are alerts and customer mood getting better or
 * worse. Not a number dump - each block answers one of those.
 *
 * Fetched once per view and never polled: past days do not change, unlike the
 * live overview above it.
 */

const RANGES = [7, 14, 30] as const

export function TrendsSection({ agencyId }: { agencyId: string }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7)
  const trends = useQuery({
    queryKey: ['insights-trends', agencyId, days],
    queryFn: ({ signal }) => fetchInsightsTrends(agencyId, days, signal),
    staleTime: 60_000,
  })

  return (
    <section aria-label="Trends" className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ink text-sm font-semibold">Trends</h2>
        <div className="flex gap-2">
          {RANGES.map((range) => (
            <Button
              key={range}
              size="sm"
              variant={range === days ? 'primary' : 'secondary'}
              onClick={() => setDays(range)}
            >
              {range} days
            </Button>
          ))}
        </div>
      </div>

      <AsyncBoundary
        isPending={trends.isPending}
        error={trends.error}
        forbiddenMessage="Trends are read by administrators, managers and security staff."
        onRetry={() => void trends.refetch()}
        skeletonRows={3}
      >
        {trends.data && (
          <>
            <DailyPanel daily={trends.data.daily} />
            <div className="grid gap-3 lg:grid-cols-2">
              <CountersPanel
                counters={trends.data.counters}
                openingSeconds={trends.data.opening_seconds_per_day}
              />
              <ServicesPanel services={trends.data.services} />
            </div>
            <DeviceUptimePanel agencyId={agencyId} days={days} />
          </>
        )}
      </AsyncBoundary>
    </section>
  )
}

export function DailyPanel({ daily }: { daily: TrendDay[] }) {
  const peak = Math.max(1, ...daily.map((d) => d.tickets_completed))
  return (
    <Panel as="section">
      <PanelHeader>
        <h3 className="text-ink text-sm font-semibold">Day by day</h3>
        <p className="text-ink-3 mt-1 text-xs">
          Days are UTC. Mood is the share of negative expressions; a day with few samples is a thin
          reading, so the sample count is shown.
        </p>
      </PanelHeader>
      <PanelBody className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-ink-3 border-line border-b text-left text-xs">
              <th className="px-4 py-2 font-medium">Day</th>
              <th className="px-4 py-2 font-medium">Tickets completed</th>
              <th className="px-4 py-2 font-medium">Avg service</th>
              <th className="px-4 py-2 font-medium">Alerts</th>
              <th className="px-4 py-2 font-medium">Mood</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((day) => (
              <tr key={day.date} className="border-line/60 border-b last:border-0">
                <td className="text-ink px-4 py-2 font-medium">{formatDay(day.date)}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="bg-accent/60 block h-2 rounded"
                      style={{ width: `${Math.round((day.tickets_completed / peak) * 96)}px` }}
                      aria-hidden
                    />
                    <span className="text-ink-2 tabular">{day.tickets_completed}</span>
                  </div>
                </td>
                <td className="text-ink-2 tabular px-4 py-2">
                  {formatDuration(day.avg_service_seconds)}
                  {day.service_samples > 0 && (
                    <span className="text-ink-3 ml-1 text-xs">n={day.service_samples}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className="text-ink-2 tabular">{day.alerts_opened}</span>
                  {day.critical_alerts_opened > 0 && (
                    <Badge tone="danger" className="ml-2">
                      {day.critical_alerts_opened} critical
                    </Badge>
                  )}
                </td>
                <td className="text-ink-2 tabular px-4 py-2">
                  {day.negative_pct === null ? (
                    '—'
                  ) : (
                    <>
                      {day.negative_pct}% negative
                      <span className="text-ink-3 ml-1 text-xs">n={day.satisfaction_samples}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  )
}

export function CountersPanel({
  counters,
  openingSeconds,
}: {
  counters: CounterPerformance[]
  openingSeconds: number | null
}) {
  return (
    <Panel as="section">
      <PanelHeader>
        <h3 className="text-ink text-sm font-semibold">Counter utilization</h3>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          {openingSeconds === null
            ? 'Set opening hours on the branch to see utilization.'
            : 'Share of opening hours spent serving. Idle includes time a counter was closed or unstaffed - that is not recorded separately.'}
        </p>
      </PanelHeader>
      <PanelBody className="p-0">
        {counters.length === 0 ? (
          <p className="text-ink-2 p-4 text-sm">No counters at this branch.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-3 border-line border-b text-left text-xs">
                <th className="px-4 py-2 font-medium">Counter</th>
                <th className="px-4 py-2 font-medium">Served</th>
                <th className="px-4 py-2 font-medium">Avg service</th>
                <th className="px-4 py-2 font-medium">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {counters.map((counter) => (
                <tr key={counter.counter_id} className="border-line/60 border-b last:border-0">
                  <td className="text-ink px-4 py-2 font-medium">
                    {counter.name ?? `Counter ${counter.number}`}
                  </td>
                  <td className="text-ink-2 tabular px-4 py-2">{counter.tickets_completed}</td>
                  <td className="text-ink-2 tabular px-4 py-2">
                    {formatDuration(counter.avg_service_seconds)}
                  </td>
                  <td className="px-4 py-2">
                    {counter.utilization_pct === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="bg-line block h-2 w-20 overflow-hidden rounded">
                          <span
                            className="bg-accent block h-2"
                            style={{ width: `${Math.min(100, counter.utilization_pct)}%` }}
                          />
                        </span>
                        <span className="text-ink-2 tabular">{counter.utilization_pct}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PanelBody>
    </Panel>
  )
}

export function ServicesPanel({ services }: { services: ServicePerformance[] }) {
  const rows = sortServices(services)
  return (
    <Panel as="section">
      <PanelHeader>
        <h3 className="text-ink text-sm font-semibold">Where the time goes</h3>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Slowest service first. One is only flagged once every service compared has at least 5
          timed tickets, so a single bad hour doesn&apos;t name a bottleneck.
        </p>
      </PanelHeader>
      <PanelBody className="p-0">
        {rows.length === 0 ? (
          <p className="text-ink-2 p-4 text-sm">No services at this branch.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-3 border-line border-b text-left text-xs">
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Served</th>
                <th className="px-4 py-2 font-medium">Avg wait</th>
                <th className="px-4 py-2 font-medium">Avg service</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((service) => (
                <tr key={service.service_id} className="border-line/60 border-b last:border-0">
                  <td className="text-ink px-4 py-2 font-medium">
                    {service.name}
                    {service.is_slowest && (
                      <Badge tone="warn" className="ml-2">
                        Slowest
                      </Badge>
                    )}
                  </td>
                  <td className="text-ink-2 tabular px-4 py-2">{service.tickets_completed}</td>
                  <td className="text-ink-2 tabular px-4 py-2">
                    {formatDuration(service.avg_queue_wait_seconds)}
                  </td>
                  <td className="text-ink-2 tabular px-4 py-2">
                    {formatDuration(service.avg_service_seconds)}
                    {service.service_samples > 0 && (
                      <span className="text-ink-3 ml-1 text-xs">n={service.service_samples}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PanelBody>
    </Panel>
  )
}
