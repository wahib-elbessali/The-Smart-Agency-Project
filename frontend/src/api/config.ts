import type { MockScenario } from '@/mocks/scenario'
import { isMockScenario } from '@/mocks/scenario'

/**
 * Every runtime switch the app needs, read in one place.
 *
 * Components must never read import.meta.env directly - if they do, "am I on
 * fixtures or the real backend?" stops being answerable from a single file.
 *
 * Security note: Vite inlines every VITE_-prefixed variable into the client
 * bundle in plain text. So nothing secret goes in one - no API keys, no tokens,
 * no credentials. Anything secret belongs on the backend. See SECURITY.md.
 */

/** Fixtures are the default: there is no backend to point at yet. */
export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== 'false'

/** Trailing slash trimmed so callers can always write paths as '/some/path'. */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

/**
 * Enforced unless explicitly disabled.
 *
 * This defaulted to off while the login REQUEST body was unknown - enforcing
 * then would have locked every screen behind a sign-in that could not succeed.
 * It is known now (endpoints/auth.ts transcribes it from the backend schema),
 * sign-in works against both fixtures and the real backend, so the reason to
 * default off is gone.
 *
 * Opting OUT is the deliberate act now, because the failure modes are not
 * symmetric: defaulting off meant a fresh clone, a CI build, or anyone serving
 * `dist/` without an env file walked straight into every screen with no sign-in
 * at all - and looked like it was working, which is how it went unnoticed.
 * Defaulting on fails the other way, loudly, at a login screen.
 */
export const AUTH_ENFORCED = import.meta.env.VITE_AUTH_ENFORCED !== 'false'

/**
 * Origin for WS /ws/attendance.
 *
 * Defaults to API_BASE_URL with the scheme swapped, which is right whenever the
 * socket is served from the same origin as the REST API. Override only if the
 * backend puts it somewhere else.
 */
/* `||`, not `??`. Env vars are strings, and an unset one in a .env file parses
   as "" rather than undefined - .env.example ships `VITE_WS_BASE_URL=` exactly
   like that. With `??` an empty value would win over the fallback and leave the
   socket pointed at nothing, failing silently. For env, empty means unset. */
export const WS_BASE_URL = (
  import.meta.env.VITE_WS_BASE_URL || API_BASE_URL.replace(/^http/, 'ws')
).replace(/\/+$/, '')

/**
 * How the JWT is presented to the WebSocket.
 *
 * A browser cannot set an Authorization header on a WebSocket handshake - that
 * is a hard limitation of the API, not an oversight - so this has to be either
 * a query parameter or the Sec-WebSocket-Protocol field. contracts/api.md does
 * not say which.
 *
 * Measured against the running backend: only the query parameter works. A
 * subprotocol handshake and an Authorization header are both rejected with 403,
 * as is a missing or invalid token. So 'query' is the only mode offered here -
 * an option that cannot work is worse than no option, because it fails silently
 * at runtime rather than loudly at configuration time.
 *
 * Still opt-in rather than on by default: until there is a backend to point at,
 * a socket that refuses to connect and says so beats one that retries nothing.
 */
export type WsAuthMode = 'query'

export const WS_AUTH_MODE: WsAuthMode | null =
  import.meta.env.VITE_WS_AUTH_MODE === 'query' ? 'query' : null

/** Name of the query parameter. Verified as `token` against the backend. */
export const WS_AUTH_QUERY_PARAM = import.meta.env.VITE_WS_AUTH_QUERY_PARAM || 'token'

/** Reconnect backoff for the attendance socket. */
export const WS_RECONNECT_MS = { min: 1_000, max: 30_000 } as const

/**
 * How many times to retry a socket that has NEVER successfully opened.
 *
 * The distinction matters. A socket that opened and later dropped is a
 * transient outage, and a wall-mounted dashboard should keep trying that
 * forever so it recovers unattended. A socket that has never opened once is
 * almost always configuration or an expired token - and because the backend
 * rejects a bad token during the handshake, the browser gets no status code and
 * cannot tell that apart from the server being down. Retrying that forever just
 * means the badge reads "Reconnecting..." indefinitely when it will never work.
 */
export const WS_MAX_INITIAL_ATTEMPTS = 6

/**
 * Fake latency band for mocked responses. Without this every screen gets built
 * with no loading state and then looks broken the first time it hits a network.
 */
export const MOCK_LATENCY_MS = { min: 200, max: 800 } as const

/** Real requests abort at this point rather than spinning forever. */
export const REQUEST_TIMEOUT_MS = 10_000

export const MOCK_SCENARIO: MockScenario = isMockScenario(import.meta.env.VITE_MOCK_SCENARIO)
  ? import.meta.env.VITE_MOCK_SCENARIO
  : 'normal'
