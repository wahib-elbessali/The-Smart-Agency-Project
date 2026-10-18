import { useQuery } from '@tanstack/react-query'
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Gauge,
  Sun,
  Thermometer,
  Umbrella,
  Wind,
  type LucideIcon,
} from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchLatestClimate } from '@/api/endpoints/climate'
import { describeWeatherCode, fetchCityWeather, type CityWeather } from '@/api/weather'
import type { Agency, LatestClimateReading } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { Clock } from '@/components/ui/Time'
import { Screen } from './Screen'

/**
 * Outside weather for each branch's city, from Open-Meteo (api/weather.ts),
 * plus the indoor readings from the DHT22/MQ-2/MQ-7 devices registered on
 * that branch (contracts/api.md, added 2026-09-23 - ingestion always wrote
 * these to `sensor_readings`, nothing read them back until now). The two are
 * kept visually separate throughout: one is a public forecast, the other is
 * this branch's own hardware, and conflating them under one "climate" number
 * would hide which is which.
 *
 * No hot/cold thresholds are invented here for either half. This screen used
 * to say exactly that as its <ContractPending> note: "what counts as too hot
 * or too cold comes from the contract, not from this screen."
 * That is still true - every StatTile below stays neutral-toned, never warn,
 * because this screen has no authority to decide a reading is a problem. A
 * device with an actual threshold configured raises its own alert elsewhere
 * (see api/endpoints/thresholds.ts) - this is just the raw numbers.
 */

function iconForSensorType(sensorType: string): LucideIcon {
  const t = sensorType.toLowerCase()
  if (t.includes('temp')) return Thermometer
  if (t.includes('humid')) return Droplets
  if (t.includes('gas') || t.includes('co')) return Wind
  return Gauge
}

function useIndoorReadings(agencyId: string) {
  return useQuery({
    queryKey: ['climate-latest', agencyId],
    queryFn: ({ signal }) => fetchLatestClimate(agencyId, signal),
    /* Sensors report on their own cadence, not a live stream - ten seconds
       keeps this close to current without a websocket for one screen. */
    refetchInterval: 10_000,
  })
}

function iconForCode(code: number): LucideIcon {
  if (code === 0) return Sun
  if (code <= 3) return CloudSun
  if (code === 45 || code === 48) return CloudFog
  if (code >= 51 && code <= 57) return CloudDrizzle
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return CloudSnow
  if (code >= 95) return CloudLightning
  return Cloud
}

function useAgencyWeather(city: string | null) {
  return useQuery({
    queryKey: ['weather', city],
    queryFn: ({ signal }) => fetchCityWeather(city as string, signal),
    enabled: city !== null,
    /* A city's weather does not need re-checking on every focus or every
       10-second poll the way the rest of this dashboard runs - it is still
       roughly true five minutes later, and Open-Meteo is a shared public
       service worth not hammering. */
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export default function Climate() {
  const scope = useScope()

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
  })

  const rows = agencies.data ?? []
  /* One branch to focus on, either because an admin opened it (AppShell's
     scope bar) or because there is only one to begin with - a MANAGER's list
     is already scoped to their own agency by the backend. Otherwise, every
     branch gets a compact card side by side. */
  const focused =
    rows.find((agency) => agency.id === scope.agencyId) ?? (rows.length === 1 ? rows[0] : null)

  return (
    <Screen
      title="Climate"
      description="Live outside weather for each branch's city, and readings from its own indoor sensors."
    >
      <AsyncBoundary
        isPending={agencies.isPending}
        error={agencies.error}
        isEmpty={rows.length === 0}
        emptyMessage="No agencies yet, so there is no city to check the weather for."
        forbiddenMessage="Agencies are managed by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void agencies.refetch()}
        skeletonRows={3}
      >
        {focused ? (
          <AgencyWeatherDetail agency={focused} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((agency) => (
              <AgencyWeatherCard key={agency.id} agency={agency} />
            ))}
          </div>
        )}
      </AsyncBoundary>
    </Screen>
  )
}

/** One branch, full detail - the StatTile row this screen was always meant to have. */
function AgencyWeatherDetail({ agency }: { agency: Agency }) {
  const weather = useAgencyWeather(agency.address)
  const indoor = useIndoorReadings(agency.id)

  return (
    <div className="space-y-3">
      <Panel as="section">
        <PanelHeader>
          <h2 className="text-ink text-sm font-semibold">{agency.name}</h2>
          <p className="text-ink-3 mt-0.5 text-xs">{agency.address ?? 'No address set'}</p>
        </PanelHeader>
        <PanelBody>
          {agency.address === null ? (
            <p className="text-ink-2 text-sm">
              This branch has no address set, so there is no city to look up.
            </p>
          ) : weather.isPending ? (
            <p className="text-ink-3 text-sm">Checking the weather in {agency.address}…</p>
          ) : weather.error ? (
            <p className="text-warn text-sm">
              Could not reach the weather service for {agency.address}.
            </p>
          ) : (
            <WeatherStats weather={weather.data} />
          )}
        </PanelBody>
      </Panel>

      <Panel as="section">
        <PanelHeader>
          <h2 className="text-ink text-sm font-semibold">Indoor readings</h2>
          <p className="text-ink-3 mt-0.5 text-xs">
            This branch's own sensors, most recent value per device and reading.
          </p>
        </PanelHeader>
        <PanelBody>
          {indoor.isPending ? (
            <p className="text-ink-3 text-sm">Checking indoor sensors…</p>
          ) : indoor.error ? (
            <p className="text-warn text-sm">
              Could not reach the sensor readings for this branch.
            </p>
          ) : indoor.data && indoor.data.length === 0 ? (
            <p className="text-ink-2 text-sm">
              No indoor sensors have reported in yet. A registered device starts appearing here as
              soon as it publishes its first reading.
            </p>
          ) : (
            <IndoorReadingsGrid readings={indoor.data ?? []} />
          )}
        </PanelBody>
      </Panel>
    </div>
  )
}

/* One decimal place is plenty for a DHT22/MQ-2/MQ-7 reading, and rounding
   here avoids repeating a raw float's trailing noise across the grid. */
function formatReading(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function IndoorReadingsGrid({ readings }: { readings: LatestClimateReading[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {readings.map((reading) => {
        const Icon = iconForSensorType(reading.sensor_type)
        return (
          <StatTile
            key={`${reading.device_id}-${reading.sensor_type}`}
            label={reading.sensor_type}
            value={`${formatReading(reading.value)}${reading.unit ?? ''}`}
            icon={<Icon className="size-4" aria-hidden />}
            hint={reading.device_name}
            detail={
              <span className="text-ink-3 text-xs">
                <Clock iso={reading.recorded_at} />
              </span>
            }
          />
        )
      })}
    </div>
  )
}

function WeatherStats({ weather }: { weather: CityWeather }) {
  const Icon = iconForCode(weather.code)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <StatTile
        label="Temperature"
        value={`${Math.round(weather.temperatureC)}°C`}
        icon={<Icon className="size-4" aria-hidden />}
        hint={describeWeatherCode(weather.code)}
      />
      <StatTile
        label="Feels like"
        value={weather.feelsLikeC === null ? '—' : `${Math.round(weather.feelsLikeC)}°C`}
        icon={<Thermometer className="size-4" aria-hidden />}
        hint="Wind and humidity factored in"
      />
      <StatTile
        label="Humidity"
        value={weather.humidityPct === null ? '—' : `${Math.round(weather.humidityPct)}%`}
        icon={<Droplets className="size-4" aria-hidden />}
      />
      <StatTile
        label="Wind"
        value={`${Math.round(weather.windKph)} km/h`}
        icon={<Wind className="size-4" aria-hidden />}
        hint={
          weather.windGustKph === null
            ? undefined
            : `Gusting to ${Math.round(weather.windGustKph)} km/h`
        }
      />
      <StatTile
        label="Precipitation"
        value={weather.precipitationMm === null ? '—' : `${weather.precipitationMm} mm`}
        icon={<Umbrella className="size-4" aria-hidden />}
        hint="This hour"
      />
      <StatTile
        label="Cloud cover"
        value={weather.cloudCoverPct === null ? '—' : `${Math.round(weather.cloudCoverPct)}%`}
        icon={<Cloud className="size-4" aria-hidden />}
      />
      <StatTile
        label="Pressure"
        value={weather.pressureHpa === null ? '—' : `${Math.round(weather.pressureHpa)} hPa`}
        icon={<Gauge className="size-4" aria-hidden />}
        hint="At sea level"
      />
    </div>
  )
}

/** Every branch at once - compact, side by side, for an admin looking at the whole estate. */
function AgencyWeatherCard({ agency }: { agency: Agency }) {
  const weather = useAgencyWeather(agency.address)
  const indoor = useIndoorReadings(agency.id)
  const Icon = weather.data ? iconForCode(weather.data.code) : Cloud

  return (
    <Panel as="section">
      <PanelBody className="flex items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <h2 className="text-ink truncate text-sm font-semibold">{agency.name}</h2>
          <p className="text-ink-3 mt-0.5 truncate text-xs">{agency.address ?? 'No address set'}</p>
          {agency.address !== null && (
            <p className="text-ink-2 mt-2 text-sm">
              {weather.isPending && 'Checking…'}
              {weather.error && <span className="text-warn">Unavailable</span>}
              {weather.data && (
                <>
                  <span className="tabular font-semibold">
                    {Math.round(weather.data.temperatureC)}°C
                  </span>{' '}
                  <span className="text-ink-3">{describeWeatherCode(weather.data.code)}</span>
                  {weather.data.humidityPct !== null && (
                    <span className="text-ink-3 tabular">
                      {' · '}
                      {Math.round(weather.data.humidityPct)}% humidity
                    </span>
                  )}
                </>
              )}
            </p>
          )}
          {/* Indoor is a separate line, never merged into the outdoor
              sentence above - one is a forecast, the other is this branch's
              own hardware, and folding them together would blur which is
              which the moment the two disagree. */}
          <p className="text-ink-3 mt-1 truncate text-xs">
            {indoor.isPending && 'Checking indoor sensors…'}
            {indoor.error && 'Indoor sensors unavailable'}
            {indoor.data && indoor.data.length === 0 && 'No indoor sensors reporting'}
            {indoor.data && indoor.data.length > 0 && (
              <>
                Indoor:{' '}
                {indoor.data
                  .map((r) => `${r.sensor_type} ${formatReading(r.value)}${r.unit ?? ''}`)
                  .join(' · ')}
              </>
            )}
          </p>
        </div>
        {agency.address !== null && (
          <span className="text-ink-3 grid size-5 shrink-0 place-items-center self-start [&_svg]:size-4">
            <Icon className="size-5" aria-hidden />
          </span>
        )}
      </PanelBody>
    </Panel>
  )
}
