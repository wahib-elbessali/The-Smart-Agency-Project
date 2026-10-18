import { fetchJson } from '../client'
import type { LoginResponse, User } from '../types'

/**
 * Auth endpoints.
 *
 * The login REQUEST body is still not in contracts/api.md - that entry's
 * `**Payload:**` block shows the response. It is documented here instead
 * because the backend source settles it:
 *
 *   backend/app/schemas/auth.py
 *     class LoginRequest(BaseModel):
 *         email: str
 *         password: str
 *
 * That is ground truth for what the server accepts, so this is transcribed
 * rather than guessed. The contract still needs the entry - raised in
 * #api-contract - and until it has one, this file is the only place the shape
 * is written down on our side.
 *
 * The backend strips and lowercases the email before lookup, so no client-side
 * normalisation is needed here.
 */

export interface Credentials {
  email: string
  password: string
}

export function login(credentials: Credentials, signal?: AbortSignal): Promise<LoginResponse> {
  return fetchJson<LoginResponse>(
    { key: 'POST /api/auth/login', path: '/api/auth/login', method: 'POST' },
    { signal, body: { email: credentials.email, password: credentials.password } },
  )
}

/**
 * POST /api/auth/refresh
 *
 * Undocumented in contracts/api.md - it is one of the twelve routes the backend
 * exposes that the contract does not mention - but it exists and matters:
 * access tokens expire after 30 minutes, so without this the dashboard stops
 * working half an hour after sign-in.
 *
 * Takes the refresh token in the body, NOT the Authorization header, and
 * returns a full token pair. `auth: false` is therefore deliberate: sending a
 * stale access token here would be pointless at best.
 *
 * The backend rotates the refresh token too, so the caller must store both
 * halves of the response, not just the access token.
 */
export function refreshSession(refreshToken: string, signal?: AbortSignal): Promise<LoginResponse> {
  return fetchJson<LoginResponse>(
    { key: 'POST /api/auth/refresh', path: '/api/auth/refresh', method: 'POST' },
    { signal, body: { refresh_token: refreshToken } },
  )
}

export function fetchCurrentUser(signal?: AbortSignal): Promise<User> {
  return fetchJson<User>({ key: 'GET /api/auth/me', path: '/api/auth/me', auth: true }, { signal })
}
