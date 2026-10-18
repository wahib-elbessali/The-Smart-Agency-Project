import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Alerts from './Alerts'
import Occupancy from './Occupancy'
import { clearSession, setSession } from '@/api/tokenStore'
import type { Role } from '@/api/types'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import { resetAlertStore } from '@/mocks/alertStore'
import { resetCameraStore, setWeaponThreshold } from '@/mocks/cameraStore'
import { mockUserForRole } from '@/mocks/currentUser'
import '@/mocks'

/* Mock mode drives both screens from the scripted fixtures in mocks/aiStreams,
   which emit a snapshot and then changes on a timer. The waits below are
   generous because the point is the sequence, not the speed. */
const WAIT = { timeout: 8000 }

/* Alerts reads the weapon threshold and the stored alerts through React
   Query, and the stored alerts need to know whose branch to read - so a query
   client (fresh per render, so nothing leaks between tests), a session and the
   branch scope. A guard by default: one branch, no picker. */
function renderScreen(node: React.ReactNode, role: Role = 'SECURITY') {
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
          <MemoryRouter>{node}</MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

/**
 * A NOTE ON WHY NOTHING HERE SAYS `expect(await findByText(x)).toBeInTheDocument()`.
 *
 * Each scripted feed emits three frames roughly 60ms apart: an empty snapshot,
 * an update carrying the detection, then an update clearing it again. So every
 * interesting string in this file exists for about sixty milliseconds and is
 * then removed on purpose - the all-clear is part of what these fixtures model.
 *
 * `findByText` resolves the instant the node appears. Chaining an assertion
 * onto the resolved node evaluates it one tick later, by which point the
 * clearing frame may already have detached it - and the test fails with
 * "element could not be found in the document" after ~90ms rather than timing
 * out, which reads like the screen never rendered it at all.
 *
 * So: let the `find` be the assertion, since it throws when nothing turns up,
 * and group anything that must hold at the SAME moment into one `waitFor` so
 * the whole group is retried against a single consistent DOM.
 */
describe('Alerts', () => {
  it('starts on the weapons feed and says all clear before anything is detected', async () => {
    renderScreen(<Alerts />)
    await screen.findByText('All clear', {}, WAIT)
  })

  it('shows a detection when a camera reports one', async () => {
    renderScreen(<Alerts />)
    await screen.findByText('pistol', {}, WAIT)
  })

  /* The feed only speaks when something changes, so quiet is normal. If the
     screen does not say that, an operator reads an empty panel as a dead
     system - or worse, a dead system as a safe building. */
  it('explains that silence is normal rather than broken', async () => {
    renderScreen(<Alerts />)
    await screen.findByText('All clear', {}, WAIT)
    /* Found, not got: the line needs the camera list, which can land a beat
       after "All clear" when the machine is busy (flaked under full runs). */
    expect(
      await screen.findByText(/only sends a message when what a camera sees changes/i, {}, WAIT),
    ).toBeInTheDocument()
  })

  it('switches feeds without carrying detections across', async () => {
    const user = userEvent.setup()
    renderScreen(<Alerts />)
    await screen.findByText('pistol', {}, WAIT)

    await user.click(screen.getByRole('button', { name: 'Watchlist' }))

    /* A weapon detection must not survive into the watchlist panel - they are
       different sockets describing different things. */
    await waitFor(() => {
      expect(screen.queryByText('pistol')).not.toBeInTheDocument()
    }, WAIT)
  })

  describe('weapon threshold', () => {
    afterEach(() => {
      resetCameraStore()
      clearSession()
    })

    /* The live stream is relayed raw, so the screen applies the threshold
       itself. The weapon script settles on a 91% knife (cam-store) and an 83%
       pistol (cam-counter): under a 90% bar the knife shows, the pistol does
       not, and the note says one was hidden. All checked in one waitFor, so
       they hold against the same DOM rather than across frames. */
    it('hides weapon detections below the threshold set on Cameras', async () => {
      setSession({
        accessToken: 'mock-token',
        refreshToken: 'mock-refresh',
        user: mockUserForRole('SECURITY'),
      })
      setWeaponThreshold({ confidence: 0.9 })
      renderScreen(<Alerts />)

      await waitFor(() => {
        expect(screen.getByText(/90% confidence or more/)).toBeInTheDocument()
        expect(screen.getByText(/1 below it is hidden/)).toBeInTheDocument()
        expect(screen.getByText('knife')).toBeInTheDocument()
        expect(screen.getByText('91% confidence')).toBeInTheDocument()
        expect(screen.queryByText('pistol')).not.toBeInTheDocument()
      }, WAIT)
    })

    it('shows a detection exactly at the threshold, as the backend does', async () => {
      setSession({
        accessToken: 'mock-token',
        refreshToken: 'mock-refresh',
        user: mockUserForRole('SECURITY'),
      })
      setWeaponThreshold({ confidence: 0.87 })
      renderScreen(<Alerts />)

      await screen.findByText('pistol', {}, WAIT)
    })
  })

  describe('weapon alert history', () => {
    /* Before as well as after: every test above runs the weapon feed too,
       and each run opens and resolves stored alerts in the mock store. */
    beforeEach(resetAlertStore)
    afterEach(() => {
      resetAlertStore()
      resetCameraStore()
    })

    /* The fixture's past: three resolved alerts at this branch, one of them
       from a camera since deleted, and Rabat's kept out. */
    it('lists the branch’s recorded alerts, and names a deleted camera as such', async () => {
      renderScreen(<Alerts />)
      const heading = await screen.findByRole('heading', { name: 'Weapon alerts' }, WAIT)
      /* Scoped to this panel: the live panel above shows every camera the
         mock feed reports, Rabat's included. */
      const panel = within(heading.closest('section') as HTMLElement)
      expect(await panel.findByText('A deleted camera', {}, WAIT)).toBeInTheDocument()
      expect(panel.queryByText('cam-store')).not.toBeInTheDocument()
    })

    /* The weapon socket pushes the stored alert's state after the commit, so
       alerts open and resolve here without a refetch. At the default 0.6, the
       script opens and closes one on cam-counter and one on cam-lobby, then
       leaves cam-counter's 83% pistol open: the 3 seeded resolved become 5,
       with 1 open. Rabat's cam-store alerts never appear here. */
    it('opens and resolves alerts as the socket pushes them', async () => {
      renderScreen(<Alerts />)
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /^open\s*1$/i })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: /^resolved\s*5$/i })).toBeInTheDocument()
      }, WAIT)
    })
  })

  /* For the watchlist feed, confidence is cosine similarity in [-1,1], not a
     probability. Rendering it as a percentage would be a fabrication about
     whether someone is a flagged person. */
  it('never renders watchlist confidence as a percentage', async () => {
    const user = userEvent.setup()
    renderScreen(<Alerts />)
    await screen.findByText('All clear', {}, WAIT)

    await user.click(screen.getByRole('button', { name: 'Watchlist' }))

    /* All three in one waitFor, and the existence check first. Issued as
       separate statements after an await, the later two would run against
       whatever the DOM had become - and once the clearing frame lands, "no 61%
       anywhere" passes for the wrong reason: because the detection is gone
       entirely, not because it was rendered as a similarity. Retried together,
       they can only pass while the detection is actually on screen. */
    await waitFor(() => {
      expect(screen.getByText('MAROUANE-B-2024-114')).toBeInTheDocument()
      expect(screen.getByText(/similarity 0\.61/)).toBeInTheDocument()
      expect(screen.queryByText(/61%/)).not.toBeInTheDocument()
    }, WAIT)
  })
})

describe('Occupancy', () => {
  it('lists every zone including one that is empty', async () => {
    renderScreen(<Occupancy />)
    expect(await screen.findByText('lobby', {}, WAIT)).toBeInTheDocument()
    /* vault starts at zero - an empty zone is measured, not missing. */
    expect(screen.getByText('vault')).toBeInTheDocument()
  })

  /* The bug this guards: a zone emptying and the screen keeping the last busy
     number, because the row was filtered out rather than set to zero. */
  it('keeps a zone visible after its count drops to zero', async () => {
    renderScreen(<Occupancy />)
    await screen.findByText('lobby', {}, WAIT)

    await waitFor(() => {
      const row = screen.getByText('lobby').closest('div')?.parentElement
      expect(row?.textContent).toMatch(/lobby0/)
    }, WAIT)
  })

  it('calls the total detections rather than a headcount', async () => {
    renderScreen(<Occupancy />)
    await screen.findByText('lobby', {}, WAIT)
    expect(screen.getByText('Detections across zones')).toBeInTheDocument()
    expect(screen.getByText(/counted in both/i)).toBeInTheDocument()
  })
})
