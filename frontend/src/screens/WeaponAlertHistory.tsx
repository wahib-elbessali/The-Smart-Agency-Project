import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchStoredAlerts } from '@/api/endpoints/alerts'
import { ApiError, describeApiError } from '@/api/errors'
import { mergeStoredAlerts, type StoredAlertsById } from '@/api/streamMerge'
import type { AlertSeverity, AlertStatus, StoredAlert } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'

/**
 * The weapon alerts the backend has recorded, open first, then the history.
 *
 * WHY THIS SITS UNDER THE LIVE PANEL RATHER THAN REPLACING IT
 *
 * The two answer different questions. The live panel is what the model sees
 * this second, everything it reports. This is what the backend decided was an
 * alert: only detections at or above the weapon threshold open one, and it
 * stays open until the camera clears. A guard who looks away for ten minutes
 * gets nothing from the live panel - the pistol came and went - and
 * everything from this one.
 *
 * WHY IT LISTENS TO THE SOCKET AS WELL AS FETCHING
 *
 * The weapon socket pushes each alert's new state once it is committed (#112),
 * so an alert opens and resolves here as it happens instead of on the next
 * refetch. `pushed` comes from the Alerts screen's one socket rather than a
 * second connection, and is laid over the fetched list by id
 * (mergeStoredAlerts explains which copy wins).
 *
 * There is no acknowledge button: the status exists in the model, but no
 * route sets it.
 */

/** Resolved alerts shown before "Show all" - the route returns every one ever. */
const RECENT = 5

const STATUS_TONE: Record<AlertStatus, Tone> = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warn',
  RESOLVED: 'neutral',
}

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  CRITICAL: 'danger',
  HIGH: 'warn',
  MEDIUM: 'info',
  LOW: 'neutral',
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const DAY_AND_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "10:04" today, "Mon 5 Oct, 10:04" otherwise - history spans days. */
function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const today = new Date().toDateString() === date.toDateString()
  return (today ? TIME : DAY_AND_TIME).format(date)
}

function lasted(fromIso: string, toIso: string): string {
  const minutes = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function AlertRow({ alert }: { alert: StoredAlert }) {
  return (
    <li className="border-line bg-panel-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3">
      <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">
        {/* camera_name is null once the camera has been deleted; the alert
            outlives it on purpose. */}
        {alert.camera_name ? (
          <span className="font-mono">{alert.camera_name}</span>
        ) : (
          <span className="text-ink-3 font-normal">A deleted camera</span>
        )}
      </span>
      <Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</Badge>
      <Badge tone={STATUS_TONE[alert.status]}>{alert.status}</Badge>
      <span className="text-ink-3 tabular w-full text-xs">
        {alert.resolved_at
          ? `${when(alert.created_at)} – ${when(alert.resolved_at)} · ${lasted(alert.created_at, alert.resolved_at)}`
          : `Since ${when(alert.created_at)}`}
      </span>
    </li>
  )
}

export function WeaponAlertHistory({ pushed }: { pushed: StoredAlertsById }) {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  const [pickedAgencyId, setPickedAgencyId] = useState<string | null>(null)
  /* The branch the admin has open wins and hides the picker below; with none
     open the picker decides, then the first branch. Everyone else has one. */
  const agencyId = isAdmin
    ? (scope.agencyId ?? pickedAgencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  const stored = useQuery({
    queryKey: ['storedAlerts', agencyId, 'weapon'],
    queryFn: ({ signal }) => fetchStoredAlerts(agencyId as string, 'weapon', signal),
    enabled: agencyId !== null,
  })

  const all = useMemo(
    () => (agencyId ? mergeStoredAlerts(stored.data ?? [], pushed, agencyId, 'weapon') : []),
    [stored.data, pushed, agencyId],
  )
  const open = all.filter((alert) => alert.status !== 'RESOLVED')
  const resolved = all.filter((alert) => alert.status === 'RESOLVED')

  const [showAll, setShowAll] = useState(false)
  const shownResolved = showAll ? resolved : resolved.slice(0, RECENT)

  return (
    <Panel as="section" className="mt-4">
      <PanelHeader>
        <div className="flex items-center gap-2">
          <History className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Weapon alerts</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          What the backend recorded. A detection at or above the threshold opens one incident per
          branch, and it stays open until someone resolves it, even after the camera clears.
        </p>
      </PanelHeader>

      <PanelBody className="space-y-4">
        {isAdmin && !scope.agencyId && (
          <div className="max-w-xs">
            <label
              htmlFor="weapon_alerts_agency"
              className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
            >
              Branch
            </label>
            <select
              id="weapon_alerts_agency"
              className={controlClass()}
              value={agencyId ?? ''}
              onChange={(e) => setPickedAgencyId(e.target.value || null)}
            >
              {(agencies.data ?? []).map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {stored.isError ? (
          <p role="alert" className="text-warn text-sm">
            {stored.error instanceof ApiError
              ? describeApiError(stored.error)
              : 'Could not load the alert history.'}
          </p>
        ) : stored.isPending ? (
          <p role="status" className="text-ink-3 text-sm">
            Loading the alert history…
          </p>
        ) : (
          <>
            <div>
              <h3 className="text-ink-2 mb-2 text-xs font-medium">
                Open <span className="text-ink-3 tabular">{open.length}</span>
              </h3>
              {open.length > 0 ? (
                <ul className="space-y-2">
                  {open.map((alert) => (
                    <AlertRow key={alert.id} alert={alert} />
                  ))}
                </ul>
              ) : (
                <p className="text-ink-3 text-sm">No open weapon alerts.</p>
              )}
            </div>

            <div>
              <h3 className="text-ink-2 mb-2 text-xs font-medium">
                Resolved <span className="text-ink-3 tabular">{resolved.length}</span>
              </h3>
              {resolved.length > 0 ? (
                <>
                  <ul className="space-y-2">
                    {shownResolved.map((alert) => (
                      <AlertRow key={alert.id} alert={alert} />
                    ))}
                  </ul>
                  {resolved.length > RECENT && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => setShowAll((all) => !all)}
                    >
                      {showAll ? 'Show fewer' : `Show all ${resolved.length}`}
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-ink-3 text-sm">Nothing resolved yet.</p>
              )}
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  )
}
