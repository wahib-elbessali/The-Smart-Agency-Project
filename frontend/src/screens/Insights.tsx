import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock3, Smile, Ticket, UserCheck } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchInsightsOverview } from '@/api/endpoints/insights'
import type { InsightsOverview } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Donut, type DonutSegment } from '@/components/charts/Donut'
import { DATA_COLORS } from '@/components/charts/palette'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { Screen } from './Screen'
import { AccessFailuresPanel } from './AccessFailuresPanel'
import { BranchComparison } from './BranchComparison'
import { TrendsSection } from './InsightsTrends'

/**
 * Monitoring dashboard - "Customer satisfaction" in the feature list, folded
 * into a wider overview alongside open alerts and the ticket queue since all
 * three are read-only aggregation the backend already had the data for
 * (contracts/api.md, added 2026-09-23).
 *
 * ADMIN, MANAGER and SECURITY - same bucket as /alerts, a monitoring view.
 *
 * Satisfaction is an aggregate EMOTION TREND, not a per-visitor score - see
 * SatisfactionInsights's own doc comment in api/types.ts for why. This screen
 * never claims more precision than that: a percentage split across the
 * window, nothing tied to one person's face or one ticket.
 */

const SEVERITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

export default function Insights() {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'

  /* ADMIN can list every agency (GET /api/agencies 403s for SECURITY), so
     only an ADMIN needs this call. Everyone else reads their own branch
     directly from the session - the backend would reject anything else
     anyway (ensure_agency_scope). */
  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  if (!isAdmin) {
    if (!user?.agency_id) return null
    return (
      <Screen
        title="Insights"
        description="Open alerts, the ticket queue, and the customer-satisfaction signal from emotion recognition."
      >
        <AgencyInsightsDetail agencyId={user.agency_id} />
      </Screen>
    )
  }

  const rows = agencies.data ?? []
  const focused =
    rows.find((agency) => agency.id === scope.agencyId) ?? (rows.length === 1 ? rows[0] : null)

  return (
    <Screen
      title="Insights"
      description="Open alerts, the ticket queue, and the customer-satisfaction signal from emotion recognition."
    >
      <AsyncBoundary
        isPending={agencies.isPending}
        error={agencies.error}
        isEmpty={rows.length === 0}
        emptyMessage="No agencies yet, so there is nothing to report on."
        onRetry={() => void agencies.refetch()}
        skeletonRows={4}
      >
        {focused ? <AgencyInsightsDetail agencyId={focused.id} /> : <BranchComparison />}
      </AsyncBoundary>
    </Screen>
  )
}

function useOverview(agencyId: string) {
  return useQuery({
    queryKey: ['insights-overview', agencyId],
    queryFn: ({ signal }) => fetchInsightsOverview(agencyId, signal),
    /* A dashboard, not a live feed - every screen using it already polls the
       stream for anything that needs to be instant. Ten seconds keeps the
       numbers fresh without hammering four aggregate queries per branch. */
    refetchInterval: 10_000,
  })
}

/** Minute-rounded - an average over a day doesn't need second precision,
 * and `—` means no eligible completed ticket yet, not a zero-second wait. */
function formatSeconds(seconds: number | null): string {
  return seconds == null ? '—' : `${Math.round(seconds / 60)}m`
}

function severitySegments(open_by_severity: Record<string, number>): DonutSegment[] {
  return SEVERITY_ORDER.map((severity, i) => ({
    label: severity.charAt(0) + severity.slice(1).toLowerCase(),
    value: open_by_severity[severity] ?? 0,
    color: DATA_COLORS[i],
  }))
}

/** One branch, full detail - the overview this screen was always meant to have. */
function AgencyInsightsDetail({ agencyId }: { agencyId: string }) {
  const overview = useOverview(agencyId)

  return (
    <AsyncBoundary
      isPending={overview.isPending}
      error={overview.error}
      forbiddenMessage="Insights are read by administrators, managers and security staff. Ask an administrator if you need access."
      onRetry={() => void overview.refetch()}
      skeletonRows={5}
    >
      {overview.data && (
        <div className="space-y-3">
          <OverviewDetail overview={overview.data} />
          <AccessFailuresPanel agencyId={agencyId} />
          <TrendsSection agencyId={agencyId} />
        </div>
      )}
    </AsyncBoundary>
  )
}

function OverviewDetail({ overview }: { overview: InsightsOverview }) {
  const { tickets, alerts, satisfaction, wait_times, visitor_recognition, service_satisfaction } =
    overview

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Waiting"
          value={tickets.waiting}
          icon={<Ticket className="size-4" aria-hidden />}
        />
        <StatTile label="In service" value={tickets.in_service} />
        <StatTile label="Completed today" value={tickets.completed_today} />
        <StatTile label="Cancelled today" value={tickets.cancelled_today} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Open alerts</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs">Open or acknowledged, by severity.</p>
          </PanelHeader>
          <PanelBody>
            {alerts.open_total === 0 ? (
              <p className="text-ink-2 text-sm">No open alerts.</p>
            ) : (
              <Donut
                segments={severitySegments(alerts.open_by_severity)}
                total={alerts.open_total}
                totalLabel="open"
                size={148}
                className="justify-center"
              />
            )}
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <Smile className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Customer satisfaction</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs">
              Emotion trend over the last {satisfaction.window_hours}h, {satisfaction.total_samples}{' '}
              {satisfaction.total_samples === 1 ? 'sample' : 'samples'}.
            </p>
          </PanelHeader>
          <PanelBody>
            {satisfaction.total_samples === 0 ? (
              <p className="text-ink-2 text-sm">
                No emotion samples in this window - nothing to report, not a neutral reading.
              </p>
            ) : (
              <Donut
                segments={[
                  {
                    label: 'Positive',
                    value: satisfaction.positive_pct ?? 0,
                    color: 'var(--color-ok)',
                  },
                  {
                    label: 'Neutral',
                    value: satisfaction.neutral_pct ?? 0,
                    color: 'var(--color-line-strong)',
                  },
                  {
                    label: 'Negative',
                    value: satisfaction.negative_pct ?? 0,
                    color: 'var(--color-danger)',
                  },
                ]}
                total={100}
                totalLabel="of samples"
                format={(n) => `${Math.round(n)}%`}
                size={148}
                className="justify-center"
              />
            )}
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <Smile className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Service satisfaction</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs">
              Scoped to an actual service window, not ambient mood -{' '}
              {service_satisfaction.tickets_with_coverage} of {wait_times.sample_count} completed{' '}
              {wait_times.sample_count === 1 ? 'ticket had' : 'tickets had'} a linked camera.
            </p>
          </PanelHeader>
          <PanelBody>
            {service_satisfaction.total_samples === 0 ? (
              <p className="text-ink-2 text-sm">
                {service_satisfaction.tickets_with_coverage === 0
                  ? 'No counter has a linked camera yet - nothing to report.'
                  : 'No emotion samples landed in a covered service window - nothing to report, not a neutral reading.'}
              </p>
            ) : (
              <Donut
                segments={[
                  {
                    label: 'Positive',
                    value: service_satisfaction.positive_pct ?? 0,
                    color: 'var(--color-ok)',
                  },
                  {
                    label: 'Neutral',
                    value: service_satisfaction.neutral_pct ?? 0,
                    color: 'var(--color-line-strong)',
                  },
                  {
                    label: 'Negative',
                    value: service_satisfaction.negative_pct ?? 0,
                    color: 'var(--color-danger)',
                  },
                ]}
                total={100}
                totalLabel="of samples"
                format={(n) => `${Math.round(n)}%`}
                size={148}
                className="justify-center"
              />
            )}
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <Clock3 className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Wait times</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs">
              Averages over completed tickets, last {wait_times.window_hours}h,{' '}
              {wait_times.sample_count} {wait_times.sample_count === 1 ? 'ticket' : 'tickets'}.
            </p>
          </PanelHeader>
          <PanelBody>
            <div className="grid grid-cols-2 gap-3">
              <StatTile
                label="Queue wait"
                value={formatSeconds(wait_times.avg_queue_wait_seconds)}
              />
              <StatTile
                label="Walk-over time"
                value={formatSeconds(wait_times.avg_walk_over_seconds)}
              />
              <StatTile
                label="Service duration"
                value={formatSeconds(wait_times.avg_service_duration_seconds)}
              />
              <StatTile label="Total time" value={formatSeconds(wait_times.avg_total_seconds)} />
            </div>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <UserCheck className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Returning visitors</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs">
              Recognized by face alone, no name required, last {visitor_recognition.window_days}{' '}
              days.
            </p>
          </PanelHeader>
          <PanelBody>
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="New visitors" value={visitor_recognition.new_visitors} />
              <StatTile label="Returning visitors" value={visitor_recognition.returning_visitors} />
              <StatTile
                label="Returning rate"
                value={
                  visitor_recognition.returning_pct == null
                    ? '—'
                    : `${Math.round(visitor_recognition.returning_pct)}%`
                }
              />
              <StatTile
                label="Avg. days between visits"
                value={
                  visitor_recognition.avg_days_between_visits == null
                    ? '—'
                    : visitor_recognition.avg_days_between_visits.toFixed(1)
                }
              />
            </div>
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}
