import { useQuery } from '@tanstack/react-query'
import { fetchDeviceUptime } from '@/api/endpoints/insights'
import type { DeviceUptime } from '@/api/types'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { formatDay, uptimeLevel, type UptimeLevel } from './trendFormat'

/**
 * Which devices are flaky, early (scenario-planning backlog, "device
 * online/offline ratio over time"). Only devices a manager marked as periodic
 * publishers (a heartbeat) are measured: a badge reader or a kiosk talks when
 * something happens, so silence from one is normal and listing it as "down"
 * would be a lie. Those are named below the table instead of being guessed at.
 *
 * The flap count sits beside the percentage on purpose - 90% reads the same
 * for one long outage and for twenty blips, and only one of those is the
 * intermittent hardware this exists to catch.
 */

const LEVEL_CLASS: Record<UptimeLevel | 'none', string> = {
  good: 'bg-ok',
  degraded: 'bg-warn',
  bad: 'bg-danger',
  none: 'bg-line',
}

function DayBars({ device }: { device: DeviceUptime }) {
  return (
    <div className="flex items-end gap-0.5" aria-label={`${device.name} uptime by day`}>
      {device.daily.map((day) => {
        const level = uptimeLevel(day.online_pct)
        return (
          <span
            key={day.date}
            title={`${formatDay(day.date)}: ${day.online_pct === null ? 'no samples' : `${day.online_pct}% online`}`}
            className={`block h-4 w-2 rounded-sm ${LEVEL_CLASS[level ?? 'none']}`}
          />
        )
      })}
    </div>
  )
}

export function DeviceUptimePanel({ agencyId, days }: { agencyId: string; days: number }) {
  const uptime = useQuery({
    queryKey: ['insights-device-uptime', agencyId, days],
    queryFn: ({ signal }) => fetchDeviceUptime(agencyId, days, signal),
    staleTime: 60_000,
  })

  return (
    <Panel as="section">
      <PanelHeader>
        <h3 className="text-ink text-sm font-semibold">Device uptime</h3>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Sampled every few minutes for devices with a heartbeat. History starts when tracking
          started; days with no samples are blank, not zero.
        </p>
      </PanelHeader>
      <PanelBody className="p-0">
        <AsyncBoundary
          isPending={uptime.isPending}
          error={uptime.error}
          forbiddenMessage="Device uptime is read by administrators, managers and security staff."
          onRetry={() => void uptime.refetch()}
          skeletonRows={2}
        >
          {uptime.data && (
            <>
              {uptime.data.devices.length === 0 ? (
                <p className="text-ink-2 p-4 text-sm leading-relaxed">
                  No device is tracked yet. A periodic device (a sensor) is tracked once it is given
                  a heartbeat - how often it should be heard from - in its device settings.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-ink-3 border-line border-b text-left text-xs">
                      <th className="px-4 py-2 font-medium">Device</th>
                      <th className="px-4 py-2 font-medium">Now</th>
                      <th className="px-4 py-2 font-medium">Uptime</th>
                      <th className="px-4 py-2 font-medium">Flaps</th>
                      <th className="px-4 py-2 font-medium">By day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uptime.data.devices.map((device) => (
                      <tr key={device.device_id} className="border-line/60 border-b last:border-0">
                        <td className="text-ink px-4 py-2 font-medium">
                          {device.name}
                          <span className="text-ink-3 ml-2 text-xs">{device.device_type}</span>
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={device.currently_online ? 'ok' : 'danger'}>
                            {device.currently_online ? 'Online' : 'Offline'}
                          </Badge>
                        </td>
                        <td className="text-ink-2 tabular px-4 py-2">
                          {device.online_pct === null ? '—' : `${device.online_pct}%`}
                          {device.samples > 0 && (
                            <span className="text-ink-3 ml-1 text-xs">n={device.samples}</span>
                          )}
                        </td>
                        <td className="text-ink-2 tabular px-4 py-2">{device.flaps}</td>
                        <td className="px-4 py-2">
                          <DayBars device={device} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {uptime.data.untracked.length > 0 && (
                <p className="text-ink-3 border-line border-t px-4 py-3 text-xs leading-relaxed">
                  Not tracked (no heartbeat, so quiet is normal for them):{' '}
                  {uptime.data.untracked.map((d) => d.name).join(', ')}.
                </p>
              )}
            </>
          )}
        </AsyncBoundary>
      </PanelBody>
    </Panel>
  )
}
