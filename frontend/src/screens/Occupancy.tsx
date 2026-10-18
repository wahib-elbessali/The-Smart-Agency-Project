import { useMemo } from 'react'
import { Info } from 'lucide-react'
import { Link } from 'react-router'
import { createOccupancyStream } from '@/api/endpoints/streams'
import { applyOccupancyFrame, totalAcrossZones, type ZonesByName } from '@/api/streamMerge'
import type { OccupancyFrame } from '@/api/types'
import { useStream } from '@/hooks/useStream'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { StreamStatusBadge } from '@/components/StreamStatusBadge'
import { Screen } from './Screen'

/**
 * How many people are standing in each zone, live.
 *
 * Same transport story as Alerts: the backend proxies the AI service and the
 * frontend never touches it directly.
 *
 * Two honesty problems this screen has to avoid, both from the contract:
 *
 * 1. **The counts are not a headcount.** Zones can overlap, a person inside two
 *    of them is counted in both, and a boundary counts as inside. So the total
 *    is labelled as detections across zones, not as people in the building.
 *
 * 2. **A zone at zero is data, not absence.** Frames arrive only when a count
 *    changes and there is no heartbeat, so hiding empty zones would leave the
 *    last busy number on a wall display long after the room emptied. Every
 *    known zone is rendered, zero included.
 */

/** Bar width as a share of the busiest zone, so the shape is readable at a glance. */
function share(count: number, busiest: number): string {
  if (busiest <= 0) return '0%'
  return `${Math.round((count / busiest) * 100)}%`
}

export default function Occupancy() {
  const { state: zones, status } = useStream<OccupancyFrame, ZonesByName>(
    'occupancy',
    createOccupancyStream,
    applyOccupancyFrame,
    () => ({}),
  )

  const names = useMemo(() => Object.keys(zones).sort(), [zones])
  const total = useMemo(() => totalAcrossZones(zones), [zones])
  const busiest = useMemo(
    () => Math.max(0, ...Object.values(zones).map((zone) => zone.count)),
    [zones],
  )

  return (
    <Screen
      title="Occupancy"
      description="Where people are standing, zone by zone."
      actions={<StreamStatusBadge status={status} />}
    >
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Zones" value={String(names.length)} />
        <StatTile label="Detections across zones" value={String(total)} />
        <StatTile label="Busiest zone" value={busiest > 0 ? String(busiest) : '—'} />
      </div>

      <Panel as="section">
        <PanelHeader>
          <h2 className="text-ink text-sm font-semibold">By zone</h2>
        </PanelHeader>
        <PanelBody className="space-y-3">
          {names.length === 0 ? (
            <div role="status" className="py-2">
              <p className="text-ink text-sm font-medium">
                {status === 'open' ? 'No zones configured' : 'Waiting for the feed'}
              </p>
              <p className="text-ink-2 mt-1.5 text-sm leading-relaxed">
                {status === 'open' ? (
                  <>
                    Zones are drawn on the{' '}
                    <Link to="/zones" className="text-ink-2 hover:text-accent underline">
                      Zones
                    </Link>{' '}
                    screen. Until at least one exists there is nothing to count.
                  </>
                ) : (
                  'Nothing here reflects the connection, not the building.'
                )}
              </p>
            </div>
          ) : (
            names.map((name) => {
              const zone = zones[name]
              if (!zone) return null
              return (
                <div key={name}>
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-ink text-sm">{name}</span>
                    <span className="text-ink tabular text-sm font-medium">{zone.count}</span>
                  </div>
                  {/* A zero-width bar still leaves the track visible, so an
                      empty zone reads as "measured, and empty". */}
                  <div className="bg-panel-2 border-line h-2 overflow-hidden rounded-full border">
                    <div
                      className="bg-accent h-full rounded-full transition-all duration-500"
                      style={{ width: share(zone.count, busiest) }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </PanelBody>
      </Panel>

      <p className="text-ink-3 mt-4 flex items-start gap-2 text-xs leading-relaxed">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Zones can overlap, and someone standing in two is counted in both — so the total is
          detections, not a headcount. Counts update only when a zone changes, with no heartbeat, so
          the badge above is the only sign the feed is alive.
        </span>
      </p>
    </Screen>
  )
}
