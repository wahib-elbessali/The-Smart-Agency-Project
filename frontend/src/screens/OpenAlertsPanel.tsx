import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, CheckCheck, CircleCheck, UserCheck } from 'lucide-react'
import { acknowledgeAlert, intrusionIsStaff, resolveAlert } from '@/api/endpoints/alerts'
import { fetchRoster } from '@/api/endpoints/employees'
import { ApiError, describeApiError } from '@/api/errors'
import type { AlertSeverity, StoredAlert } from '@/api/types'
import { alertTypeLabel, useOpenAlerts } from '@/components/openAlerts'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Clock } from '@/components/ui/Time'
import { controlClass } from '@/components/ui/control'

/** Alerts only a person closes: the camera clearing does not end them. */
const STICKY = new Set(['weapon', 'wanted', 'intrusion'])

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warn',
  CRITICAL: 'danger',
}

/**
 * Every alert still active, of every kind - the sensor and system ones
 * (temperature, gas, AI or MQTT down) included. Before this the Alerts screen
 * showed only the camera feeds, so a CRITICAL temperature alert raised the
 * bell's count and then appeared nowhere.
 *
 * Acknowledging says "someone is on it": the alert stays here until its cause
 * clears (a sensor back under its limit resolves it on its own), but it no
 * longer counts on the bell.
 */
export function OpenAlertsPanel() {
  const { ready, active } = useOpenAlerts()
  const queryClient = useQueryClient()

  const acknowledge = useMutation({
    mutationFn: (id: string) => acknowledgeAlert(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['storedAlerts'] }),
  })

  /* Weapon, watchlist and intrusion alerts never close on their own (an
     armed visitor out of view is not over); a person closes them here. */
  const resolve = useMutation({
    mutationFn: (id: string) => resolveAlert(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['storedAlerts'] }),
  })

  /* An intrusion that is really an employee the cameras lost: say who, which
     links them and closes the alert as a false alarm. */
  const itsStaff = useMutation({
    mutationFn: (v: { alertId: string; employeeId: string }) =>
      intrusionIsStaff(v.alertId, v.employeeId),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['storedAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['employees', 'tracked'] }),
        queryClient.invalidateQueries({ queryKey: ['intruders'] }),
      ]),
  })
  const error = acknowledge.error ?? resolve.error ?? itsStaff.error

  return (
    <Panel as="section" tone={active.some((a) => a.status === 'OPEN') ? 'alert' : 'neutral'}>
      <PanelHeader>
        <div className="flex items-center gap-2">
          <BellRing className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Needs attention</h2>
          {ready && active.length > 0 && <Badge tone="neutral">{active.length}</Badge>}
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          Every active alert: sensors, systems and cameras. Sensor and system alerts clear by
          themselves; a weapon, watchlist or intrusion alert stays until someone resolves it.
        </p>
      </PanelHeader>
      <PanelBody>
        {!ready ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-ink-2 text-sm" role="status">
            Nothing needs attention.
          </p>
        ) : (
          <ul className="divide-line/70 -my-1.5 divide-y">
            {active.map((alert) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-start justify-between gap-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</Badge>
                    <span className="text-ink text-sm font-medium">
                      {alertTypeLabel(alert.alert_type)}
                    </span>
                    {alert.status === 'ACKNOWLEDGED' && <Badge tone="neutral">Acknowledged</Badge>}
                  </div>
                  <p className="text-ink-2 mt-1 text-sm">{alert.message ?? alert.title ?? ''}</p>
                  <p className="text-ink-3 mt-0.5 text-xs">
                    Since <Clock iso={alert.created_at} />
                    {(alert.device_name ?? alert.camera_name) &&
                      ` · ${alert.device_name ?? alert.camera_name}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {alert.status === 'OPEN' && (
                    <Button
                      size="sm"
                      disabled={acknowledge.isPending && acknowledge.variables === alert.id}
                      onClick={() => acknowledge.mutate(alert.id)}
                    >
                      <CheckCheck className="size-3.5" aria-hidden />
                      Acknowledge
                    </Button>
                  )}
                  {alert.alert_type === 'intrusion' && alert.tracking_id && (
                    <ItsStaff
                      alert={alert}
                      pending={itsStaff.isPending && itsStaff.variables?.alertId === alert.id}
                      onPick={(employeeId) => itsStaff.mutate({ alertId: alert.id, employeeId })}
                    />
                  )}
                  {STICKY.has(alert.alert_type) && (
                    <Button
                      size="sm"
                      disabled={resolve.isPending && resolve.variables === alert.id}
                      onClick={() => resolve.mutate(alert.id)}
                    >
                      <CircleCheck className="size-3.5" aria-hidden />
                      Resolve
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error != null && (
          <p role="alert" className="text-warn mt-3 text-sm">
            {error instanceof ApiError ? describeApiError(error) : 'Could not update that alert.'}
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}

/** "It's staff → [employee]": a picker, then one click. */
function ItsStaff({
  alert,
  pending,
  onPick,
}: {
  alert: StoredAlert
  pending: boolean
  onPick: (employeeId: string) => void
}) {
  const [employeeId, setEmployeeId] = useState('')
  const roster = useQuery({
    queryKey: ['roster'],
    queryFn: ({ signal }) => fetchRoster(signal),
    staleTime: 60_000,
  })
  const here = (roster.data ?? []).filter((row) => row.agency_id === alert.agency_id)
  return (
    <div className="flex gap-2">
      <div className="w-40">
        <select
          aria-label="Which employee is it"
          className={controlClass()}
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        >
          <option value="">It's staff…</option>
          {here.map((row) => (
            <option key={row.employee_id} value={row.employee_id}>
              {row.full_name}
            </option>
          ))}
        </select>
      </div>
      <Button size="sm" disabled={!employeeId || pending} onClick={() => onPick(employeeId)}>
        <UserCheck className="size-3.5" aria-hidden />
        It's staff
      </Button>
    </div>
  )
}
