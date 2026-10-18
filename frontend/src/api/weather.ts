/**
 * Live weather for an agency's city, from Open-Meteo.
 *
 * NOT part of the mock/backend layer on purpose, and it never routes through
 * fetchJson or the USE_MOCKS switch: it is a real call to a public third-party
 * API regardless of mock mode, because there is no backend endpoint for it and
 * none is needed - Open-Meteo is free, keyless, and safe to call straight from
 * the browser. contracts/api.md has nothing to say about it and never will.
 *
 * Keyless matters beyond convenience: every VITE_ variable is inlined into the
 * bundle in plain text (see api/config.ts), so a provider that requires an API
 * key could not be called from here safely at all - the key would ship to
 * every visitor. Open-Meteo is the one class of weather API this screen is
 * allowed to use unaccompanied by a backend proxy.
 */

import { REQUEST_TIMEOUT_MS } from './config'

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export interface CityWeather {
  /** The place name Open-Meteo actually matched, which may differ in spelling
   *  or add a country from what was searched. */
  resolvedName: string
  temperatureC: number
  /** How it actually feels - factors in wind and humidity, not just the air
   *  temperature. null on the rare forecast response that omits it. */
  feelsLikeC: number | null
  /** null on the rare forecast response that omits it. */
  humidityPct: number | null
  windKph: number
  /** Strongest gust in the current interval, not the sustained speed above. */
  windGustKph: number | null
  /** mm in the current interval - 0 is a real reading, not "unknown". */
  precipitationMm: number | null
  cloudCoverPct: number | null
  /** hPa at sea level. */
  pressureHpa: number | null
  /** WMO weather code - see WEATHER_CODES below for the ones this app names. */
  code: number
}

interface GeocodeResult {
  results?: Array<{ latitude: number; longitude: number; name: string; country?: string }>
}

interface ForecastResult {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    wind_speed_10m?: number
    wind_gusts_10m?: number
    precipitation?: number
    cloud_cover?: number
    pressure_msl?: number
    weather_code?: number
  }
}

/**
 * Resolves a free-text place (an agency's `address` field, e.g. "Casablanca")
 * to coordinates, then reads the current conditions there.
 *
 * Throws rather than returning null on failure, so the screen's normal
 * AsyncBoundary loading/error handling applies without a second, bespoke
 * "no weather" state to build and test.
 *
 * Both requests carry a timeout of their own, same duration `client.ts` uses
 * for every backend call. Without one, a connection that hangs rather than
 * errors (a flaky network dropping packets silently, not refusing them)
 * leaves the query pending forever - the screen never leaves "Checking the
 * weather in…", not even after the caller's own signal would have aborted
 * it on unmount, because nothing here was listening for a timeout at all.
 */
export async function fetchCityWeather(city: string, signal?: AbortSignal): Promise<CityWeather> {
  const geocodeUrl = new URL(GEOCODE_URL)
  geocodeUrl.searchParams.set('name', city)
  geocodeUrl.searchParams.set('count', '1')
  geocodeUrl.searchParams.set('language', 'en')
  geocodeUrl.searchParams.set('format', 'json')

  const geocodeResponse = await fetch(geocodeUrl, { signal: withTimeout(signal) })
  if (!geocodeResponse.ok) throw new Error(`Geocoding failed for "${city}"`)
  const geocoded = (await geocodeResponse.json()) as GeocodeResult
  const place = geocoded.results?.[0]
  if (!place) throw new Error(`No location found for "${city}"`)

  const forecastUrl = new URL(FORECAST_URL)
  forecastUrl.searchParams.set('latitude', String(place.latitude))
  forecastUrl.searchParams.set('longitude', String(place.longitude))
  forecastUrl.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover,pressure_msl',
  )
  forecastUrl.searchParams.set('timezone', 'auto')

  const forecastResponse = await fetch(forecastUrl, { signal: withTimeout(signal) })
  if (!forecastResponse.ok) throw new Error(`Forecast failed for "${city}"`)
  const forecast = (await forecastResponse.json()) as ForecastResult
  const current = forecast.current
  if (!current || current.temperature_2m === undefined || current.weather_code === undefined) {
    throw new Error(`Forecast response for "${city}" was missing current conditions`)
  }

  return {
    resolvedName: place.country ? `${place.name}, ${place.country}` : place.name,
    temperatureC: current.temperature_2m,
    feelsLikeC: current.apparent_temperature ?? null,
    humidityPct: current.relative_humidity_2m ?? null,
    windKph: current.wind_speed_10m ?? 0,
    windGustKph: current.wind_gusts_10m ?? null,
    precipitationMm: current.precipitation ?? null,
    cloudCoverPct: current.cloud_cover ?? null,
    pressureHpa: current.pressure_msl ?? null,
    code: current.weather_code,
  }
}

/**
 * WMO weather codes, named for the ones Open-Meteo actually returns in
 * practice. Grouped rather than exhaustive - the forecast API defines more
 * codes than a small dashboard widget needs to distinguish between.
 */
export const WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
}

export function describeWeatherCode(code: number): string {
  return WEATHER_CODES[code] ?? 'Unknown conditions'
}
