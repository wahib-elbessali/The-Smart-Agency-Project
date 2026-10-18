import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { AUTH_ENFORCED } from '@/api/config'
import { useSession } from './SessionContext'

/**
 * Route guard.
 *
 * Inert until VITE_AUTH_ENFORCED=true, because there is no sign-in endpoint to
 * satisfy it with - enforcing now would lock every screen behind a login that
 * cannot succeed. The wiring is here so that turning it on is one env var once
 * the contract entry exists.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession()
  const location = useLocation()

  if (!AUTH_ENFORCED) return <>{children}</>

  if (status === 'unknown') return null

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}
