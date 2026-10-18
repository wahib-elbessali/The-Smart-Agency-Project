import { createContext, use } from 'react'
import type { User } from '@/api/types'

/**
 * Session context and its hook, kept out of the provider file so that file
 * exports only a component - otherwise fast refresh stops working for it.
 *
 * There is a real `user` now: contracts/api.md defines POST /api/auth/login and
 * GET /api/auth/me, so the shape of a user is no longer a guess. Role is on it
 * because several endpoints are role-scoped and the UI will eventually need to
 * branch on it - what each role should SEE is still a product decision nobody
 * has made, so nothing branches on it yet.
 */

export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous'

export interface SessionValue {
  status: SessionStatus
  user: User | null
  signIn(credentials: { email: string; password: string }): Promise<void>
  signOut(): void
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession(): SessionValue {
  const value = use(SessionContext)
  if (!value) throw new Error('useSession must be used inside a SessionProvider')
  return value
}
