import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Zones from './Zones'
import { createZone as postZone } from '@/api/endpoints/zones'
import { clearSession, setSession } from '@/api/tokenStore'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { Role } from '@/api/types'
import { mockUserForRole } from '@/mocks/currentUser'
import { CAMERA_ID_COUNTER, CAMERA_ID_STORE, resetCameraStore } from '@/mocks/cameraStore'
import * as zoneStore from '@/mocks/zoneStore'
import '@/mocks'

/**
 * THE SESSION IS SET IN BOTH PLACES ON PURPOSE.
 *
 * SessionContext is what the screen branches on; tokenStore is what the
 * fixtures scope by (mocks/currentUser.ts reads the session behind the
 * bearer token, exactly as the backend would). Supplying only the context
 * would leave the fixture layer answering as an unscoped ADMIN, and a
 * manager would appear to receive zones from branches they cannot see -
 * the same trap Users.test.tsx documents.
 *
 * Two things about jsdom shape what can be asserted here, and both are about
 * the canvas rather than the screen: an <img> never loads, so `onLoad` never
 * fires and the SVG overlay is never mounted; and `getScreenCTM` does not
 * exist at all. So clicking a polygon into being is not testable here. What
 * is tested is everything the drawing produces and everything around it -
 * scoping, the per-camera split, delete, and the store's own rules. The
 * click-to-coordinate mapping was verified in Chrome instead.
 */
function renderAs(role: Role) {
  const user = mockUserForRole(role)
  setSession({ accessToken: 'mock-token', refreshToken: 'mock-refresh', user })

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
          <MemoryRouter>
            <Zones />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('Zones', () => {
  beforeEach(() => {
    resetZoneAndCameras()
  })
  afterEach(clearSession)

  function resetZoneAndCameras() {
    zoneStore.resetZoneStore()
    resetCameraStore()
  }

  it('shows the zones drawn on the selected camera, and counts the rest', async () => {
    renderAs('MANAGER')

    /* cam-counter sorts before cam-lobby, so it is the camera in hand. */
    expect(await screen.findByRole('heading', { name: 'cam-counter' }, WAIT)).toBeInTheDocument()
    expect(await screen.findByText('counters', {}, WAIT)).toBeInTheDocument()

    /* lobby is on this branch's other camera; vault is in Rabat and this
       manager is never sent it at all. */
    expect(screen.getByText(/1 more on other cameras/)).toBeInTheDocument()
    expect(screen.queryByText('vault')).not.toBeInTheDocument()
  })

  it('follows the camera picker', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByText('counters', {}, WAIT)

    const picker = await screen.findByLabelText('Camera', {}, WAIT)
    await user.selectOptions(picker, within(picker).getByRole('option', { name: 'cam-lobby' }))

    expect(await screen.findByText('lobby', {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByText('counters')).not.toBeInTheDocument()
  })

  it('sends an admin every branch’s zones', async () => {
    renderAs('ADMIN')
    /* An admin starts in Casablanca, so Rabat's zone is not on screen - but
       it is in the payload, which is what the count reads from: lobby and
       vault both sit on other cameras. */
    expect(await screen.findByText('counters', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText(/2 more on other cameras/)).toBeInTheDocument()
  })

  it('deletes a zone', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByText('counters', {}, WAIT)

    await user.click(screen.getByRole('button', { name: 'Delete counters' }))

    await waitFor(() => expect(screen.queryByText('counters')).not.toBeInTheDocument(), WAIT)
    expect(zoneStore.listZones().some((zone) => zone.name === 'counters')).toBe(false)
  })

  it('refuses a zone drawn on another branch’s camera', async () => {
    /* The screen cannot build this request - its camera picker only ever
       offers the caller's own branch - but the proxy has to refuse it
       anyway, so the rule is asserted at the layer that owns it. */
    setSession({
      accessToken: 'mock-token',
      refreshToken: 'mock-refresh',
      user: mockUserForRole('MANAGER'),
    })

    await expect(
      postZone({
        name: 'vault-2',
        camera_id: CAMERA_ID_STORE,
        polygon: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

/**
 * The store's rules are the AI service's rules: three points minimum, and a
 * repeated name replaces rather than collides.
 */
describe('zoneStore', () => {
  beforeEach(zoneStore.resetZoneStore)

  it('refuses fewer than three points', () => {
    expect(() =>
      zoneStore.createZone({
        name: 'sliver',
        camera_id: CAMERA_ID_COUNTER,
        polygon: [
          [0, 0],
          [5, 5],
        ],
      }),
    ).toThrowError(/3 points/)
  })

  it('replaces a zone whose name already exists rather than adding a second', () => {
    const before = zoneStore.listZones().length

    zoneStore.createZone({
      name: 'lobby',
      camera_id: CAMERA_ID_COUNTER,
      polygon: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    })

    const after = zoneStore.listZones()
    expect(after).toHaveLength(before)
    const lobby = after.find((zone) => zone.name === 'lobby')
    expect(lobby?.polygon_px).toHaveLength(3)
    /* Including the camera: replacing moves the zone to wherever it was
       just drawn, which is the behaviour that makes the warning in the
       naming dialog worth showing. */
    expect(lobby?.camera_id).toBe(CAMERA_ID_COUNTER)
  })
})
