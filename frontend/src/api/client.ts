import { API_BASE_URL, MOCK_SCENARIO, REQUEST_TIMEOUT_MS, USE_MOCKS } from './config'
import { ApiError, toApiError } from './errors'
import { getAccessToken } from './tokenStore'
import { attemptRefresh } from './sessionBridge'
import { mockDelay } from '@/mocks/latency'
import { hasMockWriter, resolveMock, resolveMockWrite } from '@/mocks/registry'

/**
 * The single place that decides fixture vs real backend.
 *
 * Screens never call this. They call an endpoint module in src/api/endpoints/,
 * which calls this. That keeps the swap to a live backend a change to
 * .env alone - playbook 6.
 */

export interface EndpointDescriptor {
  /** Registry key for the fixture set. Convention: the contract path. */
  key: string
  /** Real path exactly as written in contracts/api.md, e.g. '/some/path'. */
  path: string
  /** Defaults to GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /**
   * Whether to send `Authorization: Bearer <token>`.
   *
   * Explicit per endpoint rather than "send it whenever we have one", because
   * POST /api/auth/login is the one call that must NOT carry a stale token, and
   * a default-on rule makes that an easy accident.
   */
  auth?: boolean
}

export interface RequestOptions {
  signal?: AbortSignal
  /**
   * JSON request body for most endpoints. A `FormData` instance is sent as
   * multipart/form-data instead and never JSON.stringify'd - the one thing
   * this app posts that isn't JSON is a photo (face/watchlist enrollment),
   * and the browser has to set its own multipart boundary in the
   * Content-Type header, which means NOT setting Content-Type by hand the
   * way the JSON path does.
   */
  body?: unknown
  /**
   * What to make of the response. `json` (the default) parses it; `blob`
   * hands the bytes back untouched, for the one contract entry that answers
   * with an image rather than JSON (a camera frame). Fixtures for a blob
   * endpoint return a Blob from their variant, the same way a JSON fixture
   * returns an object.
   */
  responseType?: 'json' | 'blob'
}

export async function fetchJson<T>(
  endpoint: EndpointDescriptor,
  options: RequestOptions = {},
): Promise<T> {
  try {
    return await sendRequest<T>(endpoint, options)
  } catch (error) {
    /* One retry, and only for the case it can actually fix.
    
       Access tokens last 30 minutes and the session refreshes ahead of expiry,
       but a timer does not fire on a sleeping machine - close a laptop lid over
       lunch and the first request back is a 401 no matter how good the
       scheduling is. So this is the backstop, not the primary path.
    
       Deliberately narrow: only a 401, only on an endpoint that sent a token,
       and only once. Retrying a 403 would loop against a permissions problem no
       token can solve, and retrying twice hides a backend that is rejecting
       everything. attemptRefresh() dedupes, so three screens 401-ing together
       produce one refresh. */
    const isExpiredToken =
      error instanceof ApiError && error.kind === 'http' && error.status === 401 && endpoint.auth

    if (!isExpiredToken) throw error

    const refreshed = await attemptRefresh()
    if (!refreshed) throw error

    return await sendRequest<T>(endpoint, options)
  }
}

async function sendRequest<T>(
  endpoint: EndpointDescriptor,
  options: RequestOptions = {},
): Promise<T> {
  const { signal, body, responseType = 'json' } = options

  if (USE_MOCKS) {
    await mockDelay(signal)
    /* A write endpoint has to mutate the mock state, not return a frozen
       fixture - otherwise creating an employee "succeeds" and the list never
       changes, which reads as a bug in the screen. */
    if (hasMockWriter(endpoint.key)) {
      return resolveMockWrite<T>(endpoint.key, body, endpoint.path)
    }
    return resolveMock<T>(endpoint.key, MOCK_SCENARIO, endpoint.path)
  }

  if (!API_BASE_URL) {
    throw new ApiError(
      'not_implemented',
      'VITE_USE_MOCKS is false but VITE_API_BASE_URL is not set.',
    )
  }

  const isFormData = body instanceof FormData

  const headers: Record<string, string> = {
    Accept: responseType === 'blob' ? 'image/*' : 'application/json',
  }

  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json'

  if (endpoint.auth) {
    const token = getAccessToken()
    if (!token) {
      /* Failing here rather than sending an unauthenticated request means the
         screen shows "you are signed out" instead of a bare 401 it has to
         interpret. */
      throw new ApiError('http', 'Not signed in.', 401)
    }
    /* "bearer" is what POST /api/auth/login returns as token_type. The scheme
       token in the header is conventionally capitalised; if the backend turns
       out to be strict about the lowercase form, this one line is the fix. */
    headers.Authorization = `Bearer ${token}`
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${endpoint.path}`, {
      method: endpoint.method ?? 'GET',
      headers,
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
      /* Explicit, not left to the default. The contract answers this now: auth
         is bearer tokens, not cookie sessions, so credentials are not sent and
         CSRF is not in play. See SECURITY.md. */
      credentials: 'same-origin',
      signal: combined,
    })
  } catch (cause) {
    throw toApiError(cause)
  }

  if (!response.ok) {
    throw new ApiError(
      'http',
      `Request to ${endpoint.path} failed.`,
      response.status,
      await readErrorList(response),
    )
  }

  if (response.status === 204) return undefined as T

  if (responseType === 'blob') {
    try {
      return (await response.blob()) as T
    } catch (cause) {
      throw toApiError(cause)
    }
  }

  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('parse', `Response from ${endpoint.path} was not valid JSON.`)
  }
}

/** The `detail.errors` strings of an error body, or [] when there are none. */
async function readErrorList(response: Response): Promise<string[]> {
  try {
    const body: unknown = await response.json()
    const detail = (body as { detail?: { errors?: unknown } } | null)?.detail
    const errors = detail?.errors
    return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}
