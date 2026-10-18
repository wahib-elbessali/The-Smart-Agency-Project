import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CameraView from './CameraView'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { Role } from '@/api/types'
import { clearSession, setSession } from '@/api/tokenStore'
import { mockUserForRole } from '@/mocks/currentUser'
import {
  CAMERA_ID_COUNTER,
  CAMERA_ID_LOBBY,
  CAMERA_ID_STORE,
  resetCameraStore,
} from '@/mocks/cameraStore'
import '@/mocks'

/**
 * The live view against the fixture frame and the scripted weapon stream.
 *
 * jsdom has no URL.createObjectURL, and an <img> in it never loads - so the
 * picture is asserted as "an image with the right alt is on the page", and
 * the overlay (which needs the image's natural size) is not exercised here.
 * The detection list beside it does not depend on the picture and is.
 */
function renderAt(role: Role, cameraId: string) {
  const user = mockUserForRole(role)
  setSession({ accessToken: 'FIXTURE.ACCESS', refreshToken: 'FIXTURE.REFRESH', user })
  const session: SessionValue = {
    status: 'authenticated',
    user,
    signIn: async () => {},
    signOut: () => {},
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext value={session}>
        <ScopeProvider>
          <MemoryRouter initialEntries={[`/cameras/${cameraId}`]}>
            <Routes>
              <Route path="cameras/:id" element={<CameraView />} />
            </Routes>
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

/* Generous, for the same reason Alerts.test.tsx is: the scripted stream
   emits on its own timer and the point is the sequence, not the speed. */
const WAIT = { timeout: 8000 }

describe('CameraView', () => {
  beforeEach(() => {
    clearSession()
    resetCameraStore()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fixture-frame'),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the current frame from an online camera', async () => {
    renderAt('SECURITY', CAMERA_ID_LOBBY)
    expect(
      await screen.findByRole('img', { name: 'Current frame from cam-lobby' }, WAIT),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'cam-lobby', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('ONLINE')).toBeInTheDocument()
  })

  /* The fixture answers 404 for a camera the backend has never heard from
     (Rabat's, OFFLINE), as the AI service does for a stream it cannot open.
     The screen names that rather than showing a broken image. */
  it('says when the detector cannot open the stream', async () => {
    renderAt('ADMIN', CAMERA_ID_STORE)
    expect(
      await screen.findByText(/cannot open this camera’s stream/i, {}, WAIT),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  /* The scripted weapon feed puts a pistol on cam-counter; the list beside
     the picture follows the feed. */
  it('lists what the weapon stream flags on this camera', async () => {
    renderAt('MANAGER', CAMERA_ID_COUNTER)
    await screen.findByText('pistol', {}, WAIT)
  })

  it('does not attribute another camera’s detections to this one', async () => {
    renderAt('MANAGER', CAMERA_ID_LOBBY)
    await screen.findByRole('img', { name: 'Current frame from cam-lobby' }, WAIT)
    /* Long enough for the scripted pistol on cam-counter to have come and
       gone; it must never have appeared here. */
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByText('pistol')).not.toBeInTheDocument()
    expect(screen.getByText(/nothing flagged on this camera/i)).toBeInTheDocument()
  })

  /* Rabat's camera is not a Casablanca guard's to see; the per-agency list
     never returns it, so the deep link resolves to nothing. */
  it('tells a guard when the camera is not in their branch', async () => {
    renderAt('SECURITY', CAMERA_ID_STORE)
    expect(
      await screen.findByText(/no camera with this id in the branches you can see/i, {}, WAIT),
    ).toBeInTheDocument()
  })

  it('finds a camera in any branch for an admin', async () => {
    renderAt('ADMIN', CAMERA_ID_STORE)
    expect(
      await screen.findByRole('heading', { name: 'cam-store', level: 1 }, WAIT),
    ).toBeInTheDocument()
  })
})
