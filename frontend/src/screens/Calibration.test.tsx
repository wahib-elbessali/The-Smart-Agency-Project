import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Calibration from './Calibration'
import { clearSession, setSession } from '@/api/tokenStore'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { Role } from '@/api/types'
import { mockUserForRole } from '@/mocks/currentUser'
import { CAMERA_ID_COUNTER, CAMERA_ID_LOBBY, resetCameraStore } from '@/mocks/cameraStore'
import * as store from '@/mocks/calibrationStore'
import '@/mocks'

/**
 * Same jsdom wall as the Zones screen: no image ever loads, so the SVG
 * overlay is never mounted and points cannot be clicked into place here.
 * What is tested is everything that decides whether the numbers mean
 * anything - the per-camera status list, the two-camera gate on alignment,
 * and the store's rules, which ARE the service's rules.
 *
 * The clicking itself is NOT verified for this screen. Its click-to-
 * coordinate mapping is the same getScreenCTM().inverse() the Zones canvas
 * uses and that one was walked through in Chrome, but this screen's own
 * canvases - the 4-corner quad and the multi-camera align grid - have not
 * been driven by hand yet. Saying so rather than implying the coverage.
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
            <Calibration />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

const SQUARE: Array<[number, number]> = [
  [100, 100],
  [500, 110],
  [520, 500],
  [90, 490],
]

describe('Calibration', () => {
  beforeEach(() => {
    store.resetCalibrationStore()
    resetCameraStore()
  })
  afterEach(clearSession)

  it('shows every camera as uncalibrated until one is done', async () => {
    renderAs('MANAGER')

    const list = await screen.findByRole('heading', { name: /this branch's cameras/i }, WAIT)
    expect(list).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('not calibrated')).toHaveLength(2), WAIT)
  })

  it('reads a saved calibration back as calibrated but not yet aligned', async () => {
    store.calibrateRect({
      camera_id: CAMERA_ID_LOBBY,
      points: SQUARE,
      img_w: 1920,
      img_h: 1080,
    })
    renderAs('MANAGER')

    expect(await screen.findByText('not aligned', {}, WAIT)).toBeInTheDocument()
    expect(screen.getAllByText('not calibrated')).toHaveLength(1)
  })

  /* Alignment reconciles cameras with each other, so one camera is not a
     thing to align - the screen says so instead of offering the button. */
  it('refuses to offer alignment until two cameras are calibrated', async () => {
    const user = userEvent.setup()
    store.calibrateRect({
      camera_id: CAMERA_ID_LOBBY,
      points: SQUARE,
      img_w: 1920,
      img_h: 1080,
    })
    renderAs('MANAGER')
    await screen.findByText('not aligned', {}, WAIT)

    await user.click(screen.getByRole('button', { name: /align the cameras/i }))

    expect(
      await screen.findByRole('heading', { name: /calibrate at least two cameras first/i }, WAIT),
    ).toBeInTheDocument()
    expect(screen.getByText(/One is done\./)).toBeInTheDocument()
  })

  it('offers both canvases once two cameras are calibrated', async () => {
    const user = userEvent.setup()
    for (const id of [CAMERA_ID_LOBBY, CAMERA_ID_COUNTER]) {
      store.calibrateRect({ camera_id: id, points: SQUARE, img_w: 1920, img_h: 1080 })
    }
    renderAs('MANAGER')
    await waitFor(() => expect(screen.getAllByText('not aligned')).toHaveLength(2), WAIT)

    await user.click(screen.getByRole('button', { name: /align the cameras/i }))

    expect(
      await screen.findByRole('heading', { name: /click one real spot in each camera/i }, WAIT),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'cam-lobby' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'cam-counter' })).toBeInTheDocument()
    /* Nothing recorded yet, so the solve is not offered. */
    expect(screen.getByRole('button', { name: /^align the cameras$/i })).toBeDisabled()
  })

  it('forgets a calibration', async () => {
    const user = userEvent.setup()
    store.calibrateRect({
      camera_id: CAMERA_ID_LOBBY,
      points: SQUARE,
      img_w: 1920,
      img_h: 1080,
    })
    renderAs('MANAGER')
    await screen.findByText('not aligned', {}, WAIT)

    await user.click(screen.getByRole('button', { name: /forget calibration for cam-lobby/i }))

    await waitFor(() => expect(screen.getAllByText('not calibrated')).toHaveLength(2), WAIT)
    expect(store.listCalibration()).toHaveLength(0)
  })

  it('keeps another branch’s calibration out of a manager’s list', async () => {
    const { fetchCalibration } = await import('@/api/endpoints/calibration')
    store.calibrateRect({
      camera_id: 'c1000000-0000-4000-8000-000000000003',
      points: SQUARE,
      img_w: 1920,
      img_h: 1080,
    })
    setSession({
      accessToken: 'mock-token',
      refreshToken: 'mock-refresh',
      user: mockUserForRole('MANAGER'),
    })

    await expect(fetchCalibration()).resolves.toHaveLength(0)
  })
})

/**
 * The store reproduces the service's behaviour, not its mathematics - the
 * rules a screen can get wrong, rather than numbers it cannot fake.
 */
describe('calibrationStore', () => {
  beforeEach(store.resetCalibrationStore)

  it('demands exactly four points', () => {
    expect(() =>
      store.calibrateRect({
        camera_id: CAMERA_ID_LOBBY,
        points: SQUARE.slice(0, 3),
        img_w: 1920,
        img_h: 1080,
      }),
    ).toThrowError(/4 points/)
  })

  it('refuses a degenerate quad, as the real solve does', () => {
    expect(() =>
      store.calibrateRect({
        camera_id: CAMERA_ID_LOBBY,
        points: [
          [100, 100],
          [102, 100],
          [103, 101],
          [101, 101],
        ],
        img_w: 1920,
        img_h: 1080,
      }),
    ).toThrowError(/trop proches|alignes/)
  })

  it('leaves a freshly calibrated camera unaligned', () => {
    const result = store.calibrateRect({
      camera_id: CAMERA_ID_LOBBY,
      points: SQUARE,
      img_w: 1920,
      img_h: 1080,
    })
    expect(result.aligned).toBe(false)
    expect(result.calib_res).toEqual([1920, 1080])
  })

  it('needs two calibrated cameras before it will align anything', () => {
    store.calibrateRect({ camera_id: CAMERA_ID_LOBBY, points: SQUARE, img_w: 1920, img_h: 1080 })
    expect(() => store.alignCameras([])).toThrowError(/deux cameras/)
  })

  /**
   * The case worth pinning: a camera nothing connects to comes back
   * `aligned: false` WITH the call succeeding. A screen that treats 200 as
   * success reports a site that agrees with itself when it does not.
   */
  it('reports an unreachable camera per-camera rather than failing the call', () => {
    store.calibrateRect({ camera_id: CAMERA_ID_LOBBY, points: SQUARE, img_w: 1920, img_h: 1080 })
    store.calibrateRect({ camera_id: CAMERA_ID_COUNTER, points: SQUARE, img_w: 1920, img_h: 1080 })

    const result = store.alignCameras([{ [CAMERA_ID_LOBBY]: [10, 10] }])

    expect(result.results[CAMERA_ID_COUNTER].aligned).toBe(false)
    expect(result.results[CAMERA_ID_COUNTER].error).toMatch(/no chain of >=2-point/)
  })

  it('aligns on two shared points, and says the fit was weak below four', () => {
    store.calibrateRect({ camera_id: CAMERA_ID_LOBBY, points: SQUARE, img_w: 1920, img_h: 1080 })
    store.calibrateRect({ camera_id: CAMERA_ID_COUNTER, points: SQUARE, img_w: 1920, img_h: 1080 })

    const result = store.alignCameras([
      { [CAMERA_ID_LOBBY]: [10, 10], [CAMERA_ID_COUNTER]: [20, 20] },
      { [CAMERA_ID_LOBBY]: [30, 30], [CAMERA_ID_COUNTER]: [40, 40] },
    ])

    expect(result.results[CAMERA_ID_COUNTER]).toMatchObject({ aligned: true, n_points: 2 })
    expect(result.weak_fits).toMatch(/<4 shared points/)
    expect(store.listCalibration().every((entry) => entry.aligned)).toBe(true)
  })

  /* Re-measuring a camera changes its floor frame, so whatever it was
     reconciled with no longer holds. */
  it('drops alignment when a camera is recalibrated', () => {
    store.calibrateRect({ camera_id: CAMERA_ID_LOBBY, points: SQUARE, img_w: 1920, img_h: 1080 })
    store.calibrateRect({ camera_id: CAMERA_ID_COUNTER, points: SQUARE, img_w: 1920, img_h: 1080 })
    store.alignCameras([
      { [CAMERA_ID_LOBBY]: [10, 10], [CAMERA_ID_COUNTER]: [20, 20] },
      { [CAMERA_ID_LOBBY]: [30, 30], [CAMERA_ID_COUNTER]: [40, 40] },
    ])

    store.calibrateRect({ camera_id: CAMERA_ID_COUNTER, points: SQUARE, img_w: 1920, img_h: 1080 })

    const counter = store.listCalibration().find((e) => e.camera_id === CAMERA_ID_COUNTER)
    expect(counter?.aligned).toBe(false)
  })
})
