import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import Agencies from './Agencies'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { User } from '@/api/types'
import { AGENCY_ID } from '@/mocks/fixtures/people'
import { resetAgencyStore } from '@/mocks/agencyStore'
import '@/mocks'

/**
 * The role split is the whole point of this screen, so the session is supplied
 * directly rather than signed in through the provider.
 *
 * Signing in through POST /api/auth/login would work too now that the fixture
 * reads the role from the typed email (mockUserForEmail in mocks/currentUser.ts)
 * rather than from MOCK_SCENARIO - but it is still an extra async round trip
 * this test has no use for. What is being asserted is that the screen branches
 * on `user.role` and nothing else, so handing it a role directly is both
 * simpler and faster than a sign-in this test does not otherwise need.
 */
function sessionFor(role: User['role']): SessionValue {
  return {
    status: 'authenticated',
    user: {
      id: 'u-test',
      full_name: role === 'ADMIN' ? 'Admin Test' : 'Leila Fassi',
      email: 'test@agency.com',
      role,
      agency_id: role === 'ADMIN' ? null : AGENCY_ID,
      is_active: true,
    },
    signIn: async () => {},
    signOut: () => {},
  }
}

function renderAs(role: User['role']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext value={sessionFor(role)}>
        <ScopeProvider>
          <MemoryRouter>
            <Agencies />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('Agencies', () => {
  beforeEach(resetAgencyStore)

  it('lists the branches with their hours', async () => {
    renderAs('ADMIN')
    expect(await screen.findByText('Agence Casablanca', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('Agence Rabat')).toBeInTheDocument()
    /* "08:30", not the API's "08:30:00" - the raw value reads as machine
       output on a screen a person is scanning. */
    expect(screen.getByText('08:30')).toBeInTheDocument()
  })

  it('shows which counters are closed, since a closed one refuses a call', async () => {
    renderAs('ADMIN')
    await screen.findByText('Agence Casablanca', {}, WAIT)
    expect(screen.getByText(/Guichet 3 · closed/)).toBeInTheDocument()
  })

  describe('role gating', () => {
    /* POST and DELETE are ADMIN-only for every row, so a manager clicking them
       could never succeed - those are hidden. PUT allows a manager on their own
       agency, so Edit stays. */
    it('offers create and delete to an admin', async () => {
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      expect(screen.getByRole('button', { name: /add agency/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete agence casablanca/i })).toBeInTheDocument()
    })

    it('offers neither to a manager', async () => {
      renderAs('MANAGER')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      expect(screen.queryByRole('button', { name: /add agency/i })).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /delete agence casablanca/i }),
      ).not.toBeInTheDocument()
    })

    it('still lets a manager edit, which the route allows for their own agency', async () => {
      renderAs('MANAGER')
      await screen.findByText('Agence Casablanca', {}, WAIT)
      expect(screen.getByRole('button', { name: /edit agence casablanca/i })).toBeInTheDocument()
    })
  })

  describe('delete confirmation', () => {
    /* The cascade is the widest in the contract - employees, visitors, devices,
       cameras, alerts, and every attendance record those employees had. A
       generic "cannot be undone" is the sentence people click past. */
    it('names what this specific delete destroys', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /delete agence casablanca/i }))
      const dialog = screen.getByRole('dialog')

      expect(within(dialog).getByText(/10 employees/)).toBeInTheDocument()
      expect(within(dialog).getByText(/3 counters/)).toBeInTheDocument()
      expect(within(dialog).getByText(/2 devices/)).toBeInTheDocument()
    })

    it('offers deactivating instead, which keeps the history', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /delete agence casablanca/i }))
      expect(
        within(screen.getByRole('dialog')).getByRole('button', { name: /set to inactive/i }),
      ).toBeInTheDocument()
    })

    it('removes the agency once confirmed', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Rabat', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /delete agence rabat/i }))
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: /delete permanently/i }),
      )

      await waitFor(() => {
        expect(screen.queryByText('Agence Rabat')).not.toBeInTheDocument()
      }, WAIT)
    })
  })

  describe('create', () => {
    it('adds the agency and shows it in the list', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /add agency/i }))
      const dialog = screen.getByRole('dialog')
      await user.type(within(dialog).getByLabelText(/^name/i), 'Agence Fes')
      await user.click(within(dialog).getByRole('button', { name: /create agency/i }))

      await waitFor(() => {
        expect(screen.getByText('Agence Fes')).toBeInTheDocument()
      }, WAIT)
    })

    it('enforces the contract two-character minimum before sending', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /add agency/i }))
      const dialog = screen.getByRole('dialog')
      await user.type(within(dialog).getByLabelText(/^name/i), 'A')
      await user.click(within(dialog).getByRole('button', { name: /create agency/i }))

      expect(within(dialog).getByText(/at least 2 characters/i)).toBeInTheDocument()
    })

    /* Both offending rows are on screen, so this is one of the few server rules
       worth reproducing client-side rather than waiting for the 409. */
    it('catches duplicate counter numbers in the form', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /add agency/i }))
      const dialog = screen.getByRole('dialog')
      await user.type(within(dialog).getByLabelText(/^name/i), 'Agence Fes')

      await user.click(within(dialog).getByRole('button', { name: /add counter/i }))
      await user.click(within(dialog).getByRole('button', { name: /add counter/i }))

      // Second row defaults to 2; make it collide with the first.
      const second = within(dialog).getByLabelText(/counter 2 number/i)
      await user.clear(second)
      await user.type(second, '1')

      expect(within(dialog).getByText(/must be unique within the agency/i)).toBeInTheDocument()
    })

    /* Counters cannot be added after creation - the contract has no route for
       it - so the form has to say so while it is still possible. */
    it('warns that counters are create-only', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /add agency/i }))
      expect(
        within(screen.getByRole('dialog')).getByText(/no route to add one afterwards/i),
      ).toBeInTheDocument()
    })
  })

  describe('edit', () => {
    /* PUT's documented body has no zones or counters, so the form must not
       offer them - a control that silently does nothing is worse than none. */
    it('does not offer counters when editing', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /edit agence casablanca/i }))
      const dialog = screen.getByRole('dialog')

      expect(within(dialog).queryByRole('button', { name: /add counter/i })).not.toBeInTheDocument()
      expect(within(dialog).getByLabelText(/status/i)).toBeInTheDocument()
    })

    it('loads the existing hours without the seconds the input cannot show', async () => {
      const user = userEvent.setup()
      renderAs('ADMIN')
      await screen.findByText('Agence Casablanca', {}, WAIT)

      await user.click(screen.getByRole('button', { name: /edit agence casablanca/i }))
      const dialog = screen.getByRole('dialog')

      expect(within(dialog).getByLabelText(/opening time/i)).toHaveValue('08:30')
    })
  })
})
