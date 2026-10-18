import { useQueries, useQuery } from '@tanstack/react-query'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchStoredAlerts } from '@/api/endpoints/alerts'
import type { StoredAlert } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'

/**
 * Every stored alert still active (OPEN or ACKNOWLEDGED) in the branches this
 * user is looking at - one source for the top-bar bell and the Alerts screen's
 * "Needs attention" panel, so the two can never disagree.
 *
 * Scope follows the rest of the app: a manager or guard sees their own branch;
 * an admin the branch they are inside, or every branch when inside none.
 * Polled every 5 s: sensor, system and intrusion alerts (temperature, gas,
 * AI or MQTT down, someone in a restricted zone) have no socket of their own,
 * and 15 s was too slow for an intruder on screen (their push notification
 * is immediate either way).
 */
export const OPEN_ALERTS_POLL_MS = 5_000

export function useOpenAlerts(): {
  ready: boolean
  active: StoredAlert[]
  /** OPEN only: what nobody has acknowledged yet. */
  unseen: number
} {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin && !scope.agencyId,
  })

  const agencyIds = isAdmin
    ? scope.agencyId
      ? [scope.agencyId]
      : (agencies.data ?? []).map((agency) => agency.id)
    : user?.agency_id
      ? [user.agency_id]
      : []

  const results = useQueries({
    queries: agencyIds.map((id) => ({
      queryKey: ['storedAlerts', id, 'all'],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchStoredAlerts(id, undefined, signal),
      refetchInterval: OPEN_ALERTS_POLL_MS,
    })),
  })

  /* No partial answer: a count summed over half the branches is a wrong
     number, and a wrong number on a security control is worse than none. */
  const ready = results.length > 0 && results.every((result) => result.data !== undefined)
  const active = ready
    ? results
        .flatMap((result) => result.data ?? [])
        .filter((alert) => alert.status !== 'RESOLVED')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    : []
  return { ready, active, unseen: active.filter((alert) => alert.status === 'OPEN').length }
}

/** What an alert_type means, in words. Unknown types show as they are. */
export const ALERT_TYPE_LABEL: Record<string, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  gas_co: 'Gas / CO',
  ai_service_down: 'AI service down',
  mqtt_down: 'Sensor network down',
  weapon: 'Weapon',
  fire: 'Fire or smoke',
  wanted: 'Watchlist match',
  emotion: 'Distress',
  intrusion: 'Intruder in a restricted zone',
  zone_watch_down: 'Restricted zones not watched',
}

export function alertTypeLabel(alertType: string): string {
  return ALERT_TYPE_LABEL[alertType] ?? alertType
}
