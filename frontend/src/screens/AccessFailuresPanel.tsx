import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, DoorClosed } from 'lucide-react'
import { fetchAccessFailures } from '@/api/endpoints/insights'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { describeDoor, reasonLabel } from './accessFormat'

/**
 * Failed badge attempts per door (scenario-planning backlog, "Flaky
 * sensor/device"). Before this a failed scan left no trace anywhere, so a
 * flaky reader misreading a valid card, a card physically wearing out, and
 * someone testing random cards at a door could not be told apart.
 *
 * A dashboard signal only, on purpose - never a push. The cause is genuinely
 * ambiguous (hardware fault, worn card, probing), not a confirmed emergency,
 * so this shows the evidence (how many failures, how many different cards,
 * which reasons) and leaves the judgement to the person looking.
 */
export function AccessFailuresPanel({ agencyId }: { agencyId: string }) {
  const access = useQuery({
    queryKey: ['insights-access', agencyId],
    queryFn: ({ signal }) => fetchAccessFailures(agencyId, signal),
    /* A live signal, unlike the history below it. */
    refetchInterval: 15_000,
  })

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <DoorClosed className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Failed badge attempts</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Last 24 hours, per door. A flaky reader, a worn card and someone testing cards look alike
          from here - compare how many different cards are failing.
        </p>
      </PanelHeader>
      <PanelBody className="space-y-3">
        <AsyncBoundary
          isPending={access.isPending}
          error={access.error}
          forbiddenMessage="Door activity is read by administrators, managers and security staff."
          onRetry={() => void access.refetch()}
          skeletonRows={2}
        >
          {access.data && access.data.doors.length === 0 && (
            <p role="status" className="text-ink-2 text-sm">
              No failed badge attempts in the last 24 hours.
            </p>
          )}
          {access.data?.threshold === null && access.data.doors.length > 0 && (
            <p className="text-ink-3 text-xs">
              The alert threshold is switched off for this branch; failures are still recorded.
            </p>
          )}
          {access.data?.doors.map((door) => (
            <div
              key={door.device_id}
              className={`rounded-lg border p-3 ${door.flagged ? 'border-warn/40 bg-warn/5' : 'border-line'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-ink text-sm font-medium">{door.name}</p>
                {door.flagged && (
                  <Badge tone="warn">
                    <AlertTriangle className="mr-1 inline size-3" aria-hidden />
                    Check this reader
                  </Badge>
                )}
              </div>
              <p className="text-ink-2 mt-1 text-xs">
                {describeDoor(door, access.data?.window_minutes ?? 10)}
              </p>
              {Object.keys(door.by_reason).length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {Object.entries(door.by_reason).map(([reason, count]) => (
                    <Badge key={reason} tone="neutral">
                      {reasonLabel(reason)} · {count}
                    </Badge>
                  ))}
                </p>
              )}
              <ul className="text-ink-3 mt-2 space-y-0.5 text-xs">
                {door.recent.map((event) => (
                  <li key={`${event.occurred_at}-${event.scanned_uid}`} className="tabular">
                    {new Date(event.occurred_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {event.scanned_uid}
                    {event.employee_name ? ` (${event.employee_name})` : ''} ·{' '}
                    {reasonLabel(event.reason)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </AsyncBoundary>
      </PanelBody>
    </Panel>
  )
}
