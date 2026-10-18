import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Staffing from './Staffing'
import { createWorkstation as postWorkstation } from '@/api/endpoints/workstations'
import { clearSession, setSession } from '@/api/tokenStore'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { Role } from '@/api/types'
import { mockUserForRole } from '@/mocks/currentUser'
import { resetCameraStore } from '@/mocks/cameraStore'
import { resetZoneStore } from '@/mocks/zoneStore'
import * as workstationStore from '@/mocks/workstationStore'
import '@/mocks'

/**
 * Session in both places, for the reason Zones.test.tsx spells out: the
 * screen branches on the context, the fixtures scope by tokenStore.
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
            <Staffing />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('Staffing', () => {
  beforeEach(() => {
    workstationStore.resetWorkstationStore()
    resetZoneStore()
    resetCameraStore()
  })
  afterEach(clearSession)

  it('lists this branch’s counters and keeps the other branch’s out', async () => {
    renderAs('MANAGER')

    expect(await screen.findByRole('heading', { name: 'accueil' }, WAIT)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'guichet-3' })).toBeInTheDocument()
    /* coffre watches the Rabat zone, which this manager cannot see. */
    expect(screen.queryByRole('heading', { name: 'coffre' })).not.toBeInTheDocument()
  })

  it('shows an admin the one nothing has ever measured, as a camera problem', async () => {
    renderAs('ADMIN')

    expect(await screen.findByRole('heading', { name: 'coffre' }, WAIT)).toBeInTheDocument()
    /* Not "away": zone_known is false, so there is no reading to report. */
    expect(screen.getByText(/Nothing has been measured here yet/)).toBeInTheDocument()
    expect(screen.getByText(/camera to check rather than a counter to staff/)).toBeInTheDocument()
  })

  /**
   * The banner is what a manager is meant to act on, so it is pinned on the
   * one state the fixtures hold steady: accueil is empty in both the list and
   * the feed's opening snapshot. The scripted flip of guichet-3 is left to
   * the eye in a browser - asserting a transition that lasts 20ms under test
   * would pin the mock's pacing rather than the screen's behaviour, and
   * applyWorkstationFrame is unit-tested for the transition itself.
   */
  it('names the counters nobody is at', async () => {
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'guichet-3' }, WAIT)

    const banner = await screen.findByText(/counter[s]? (has|have) nobody at (it|them)/, {}, WAIT)
    expect(banner).toBeInTheDocument()
    expect(screen.getByText(/accueil/, { selector: 'p' })).toBeInTheDocument()
    /* Past the window, so the wording must not suggest a brief step away. */
    expect(screen.getByText(/Not somebody stepping away/)).toBeInTheDocument()
  })

  /**
   * `since` on an `away` row is when the service DECLARED it away, which is
   * already five minutes after the counter emptied. Saying "empty just now"
   * off that number was the first bug this screen shipped in a browser, so
   * the corrected wording is pinned.
   */
  it('reports when a counter was flagged, not that it just emptied', async () => {
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'accueil' }, WAIT)

    expect(screen.getByText(/Nobody there for at least five minutes/)).toBeInTheDocument()
    expect(screen.getByText(/flagged 12 min ago/)).toBeInTheDocument()
    expect(screen.queryByText(/Empty just now/)).not.toBeInTheDocument()
  })

  it('binds a new workstation to an existing zone', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'accueil' }, WAIT)

    /* The button waits on the zones query - there is nothing to bind to
       until at least one zone exists, and the header says so by not
       offering it. */
    await user.click(await screen.findByRole('button', { name: /add workstation/i }, WAIT))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText(/^name/i), 'guichet-1')
    await user.selectOptions(within(dialog).getByLabelText(/^zone/i), 'lobby')
    await user.click(within(dialog).getByRole('button', { name: /add workstation/i }))

    expect(await screen.findByRole('heading', { name: 'guichet-1' }, WAIT)).toBeInTheDocument()
    /* Starts unclassified rather than away - nothing has been read yet. */
    expect(workstationStore.listWorkstations().find((s) => s.name === 'guichet-1')).toMatchObject({
      status: 'unknown',
      zone_known: false,
      zone: 'lobby',
    })
  })

  it('unbinds a workstation', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByRole('heading', { name: 'accueil' }, WAIT)

    await user.click(screen.getByRole('button', { name: 'Unbind accueil' }))

    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'accueil' })).not.toBeInTheDocument(),
      WAIT,
    )
  })

  it('refuses a workstation bound to another branch’s zone', async () => {
    setSession({
      accessToken: 'mock-token',
      refreshToken: 'mock-refresh',
      user: mockUserForRole('MANAGER'),
    })

    await expect(postWorkstation({ name: 'coffre-2', zone: 'vault' })).rejects.toMatchObject({
      status: 403,
    })
  })
})

describe('workstationStore', () => {
  beforeEach(() => {
    workstationStore.resetWorkstationStore()
    resetZoneStore()
  })

  /* The AI service's own refusal: a workstation names a zone that must
     already exist, which is why the form picks rather than types. */
  it('refuses a zone that does not exist', () => {
    expect(() =>
      workstationStore.createWorkstation({ name: 'guichet-9', zone: 'nowhere' }),
    ).toThrowError(/n'existe pas/)
  })
})
