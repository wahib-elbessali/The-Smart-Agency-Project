import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import Cameras from './Cameras'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { Role } from '@/api/types'
import { mockUserForRole } from '@/mocks/currentUser'
import {
  CAMERA_ID_LOBBY,
  getWeaponThreshold,
  listCameras,
  resetCameraStore,
} from '@/mocks/cameraStore'
import { AGENCY_ID } from '@/mocks/fixtures/people'
import '@/mocks'

/**
 * Session supplied directly, as in Agencies.test.tsx: what is asserted is that
 * the screen branches on `user.role` and `user.agency_id`, and a sign-in round
 * trip would add nothing to that. The users are the seeded ones from
 * mocks/currentUser.ts so the SECURITY case is a real Casablanca guard.
 */
function renderAs(role: Role) {
  const session: SessionValue = {
    status: 'authenticated',
    user: mockUserForRole(role),
    signIn: async () => {},
    signOut: () => {},
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext value={session}>
        <ScopeProvider>
          <MemoryRouter>
            <Cameras />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

/* The only two-branch list on the screen is the admin's picker; camera
   cards each have their own heading, so a name is found as one. */
const cameraHeading = (name: string) => screen.queryByRole('heading', { name })

describe('Cameras', () => {
  beforeEach(resetCameraStore)

  it('lists the branch cameras with whether the detector has heard from them', async () => {
    renderAs('MANAGER')
    expect(await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)).toBeInTheDocument()
    expect(cameraHeading('cam-counter')).toBeInTheDocument()
    /* Rabat's camera is not this manager's to see. */
    expect(cameraHeading('cam-store')).not.toBeInTheDocument()

    expect(screen.getAllByText('ONLINE')).toHaveLength(2)
    expect(screen.getByText('rtsp://192.168.1.16:8554/lobby')).toBeInTheDocument()
  })

  it('lets an admin switch branch and sees the other list', async () => {
    const user = userEvent.setup()
    renderAs('ADMIN')
    await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

    const picker = await screen.findByLabelText('Branch', {}, WAIT)
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBe(2), WAIT)
    await user.selectOptions(picker, within(picker).getByRole('option', { name: 'Agence Rabat' }))

    expect(await screen.findByRole('heading', { name: 'cam-store' }, WAIT)).toBeInTheDocument()
    expect(cameraHeading('cam-lobby')).not.toBeInTheDocument()
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
  })

  it('adds a camera and it appears in the list, OFFLINE until the detector reports', async () => {
    const user = userEvent.setup()
    renderAs('SECURITY')
    await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

    await user.click(screen.getByRole('button', { name: /add camera/i }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText(/^name/i), 'cam-vault')
    await user.type(within(dialog).getByLabelText(/stream url/i), 'rtsp://192.168.1.20:8554/vault')
    await user.click(within(dialog).getByRole('button', { name: /add camera/i }))

    expect(await screen.findByRole('heading', { name: 'cam-vault' }, WAIT)).toBeInTheDocument()
    const created = listCameras(AGENCY_ID).find((c) => c.name === 'cam-vault')
    expect(created?.status).toBe('OFFLINE')
    expect(created?.stream_url).toBe('rtsp://192.168.1.20:8554/vault')
  })

  it('refuses a stream address that is not a network video address, without sending it', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

    await user.click(screen.getByRole('button', { name: /add camera/i }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText(/^name/i), 'cam-demo')
    await user.type(within(dialog).getByLabelText(/stream url/i), 'C:\videos\demo.mp4')
    await user.click(within(dialog).getByRole('button', { name: /add camera/i }))

    expect(
      within(dialog).getByText(/Use an rtsp:\/\/, rtsps:\/\/, http:\/\/ or https:\/\/ address/),
    ).toBeInTheDocument()
    expect(listCameras(AGENCY_ID).some((c) => c.name === 'cam-demo')).toBe(false)
  })

  /* The refusal that is easiest to walk into: the name is unique across
     every branch, not just this one, so a Casablanca guard reusing Rabat's
     name is refused even though they cannot see Rabat's camera. */
  it('explains a name clash with a camera at another branch', async () => {
    const user = userEvent.setup()
    renderAs('SECURITY')
    await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

    await user.click(screen.getByRole('button', { name: /add camera/i }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText(/^name/i), 'cam-store')
    await user.type(within(dialog).getByLabelText(/stream url/i), 'rtsp://x')
    await user.click(within(dialog).getByRole('button', { name: /add camera/i }))

    expect(await within(dialog).findByRole('alert', {}, WAIT)).toHaveTextContent(
      /already uses that name or that stream URL/i,
    )
    expect(listCameras(AGENCY_ID)).toHaveLength(2)
  })

  /* Since backend #113 the stream is unique too: two cameras on one feed
     would make the detector report the same picture twice under two names. */
  it('explains a stream already used by a camera at another branch', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

    await user.click(screen.getByRole('button', { name: /add camera/i }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText(/^name/i), 'cam-new')
    await user.type(within(dialog).getByLabelText(/stream url/i), 'rtsp://192.168.2.10:8554/store')
    await user.click(within(dialog).getByRole('button', { name: /add camera/i }))

    expect(await within(dialog).findByRole('alert', {}, WAIT)).toHaveTextContent(/that stream URL/i)
    expect(listCameras(AGENCY_ID)).toHaveLength(2)
  })

  it('renames a camera in place', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'cam-counter' }, WAIT)

    await user.click(screen.getByRole('button', { name: 'Edit cam-counter' }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    const name = within(dialog).getByLabelText(/^name/i)
    await user.clear(name)
    await user.type(name, 'cam-counter-2')
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }))

    expect(await screen.findByRole('heading', { name: 'cam-counter-2' }, WAIT)).toBeInTheDocument()
    expect(cameraHeading('cam-counter')).not.toBeInTheDocument()
  })

  describe('role gating', () => {
    /* DELETE drops SECURITY (cameras.py), so the button is not offered; the
       rest of the screen is theirs. */
    it('offers delete to a manager but not to security', async () => {
      renderAs('MANAGER')
      await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)
      expect(screen.getByRole('button', { name: 'Delete cam-lobby' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit cam-lobby' })).toBeInTheDocument()
    })

    it('hides delete from security, keeping edit and add', async () => {
      renderAs('SECURITY')
      await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)
      expect(screen.queryByRole('button', { name: 'Delete cam-lobby' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit cam-lobby' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /add camera/i })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'View cam-lobby' })).toHaveAttribute(
        'href',
        `/cameras/${CAMERA_ID_LOBBY}`,
      )
      /* And no branch picker: GET /api/agencies is not theirs to call. */
      expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument()
    })

    it('deletes after confirming', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByRole('heading', { name: 'cam-lobby' }, WAIT)

      await user.click(screen.getByRole('button', { name: 'Delete cam-counter' }))
      const dialog = await screen.findByRole('dialog', {}, WAIT)
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      await waitFor(() => expect(cameraHeading('cam-counter')).not.toBeInTheDocument(), WAIT)
      expect(listCameras(AGENCY_ID).map((c) => c.name)).toEqual(['cam-lobby'])
    })
  })

  describe('weapon threshold', () => {
    it('shows the current value and saves a new one', async () => {
      const user = userEvent.setup()
      renderAs('SECURITY')

      const input = await screen.findByLabelText(/minimum confidence/i, {}, WAIT)
      await waitFor(() => expect(input).toHaveValue(0.6), WAIT)
      /* Nothing typed yet, so there is nothing to save. */
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

      await user.clear(input)
      await user.type(input, '0.75')
      await user.click(screen.getByRole('button', { name: /^save$/i }))

      await waitFor(() => expect(getWeaponThreshold().confidence).toBe(0.75), WAIT)
      /* Saved and settled: the field shows the server value again and Save
         goes quiet until the next edit. */
      await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())
      expect(input).toHaveValue(0.75)
    })

    /* The same rule as the request's Field(gt=0, le=1), said before the round
       trip rather than as a 422 after it. */
    it('refuses a value outside (0, 1] without sending it', async () => {
      const user = userEvent.setup()
      renderAs('MANAGER')

      const input = await screen.findByLabelText(/minimum confidence/i, {}, WAIT)
      await waitFor(() => expect(input).toHaveValue(0.6), WAIT)

      await user.clear(input)
      await user.type(input, '0')
      expect(screen.getByText(/greater than 0 and at most 1/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

      await user.clear(input)
      await user.type(input, '1.5')
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
      expect(getWeaponThreshold().confidence).toBe(0.6)
    })
  })
})
