import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Users from './Users'
import { ScopeProvider } from '@/agency/scope'
import { SessionContext } from '@/auth/SessionContext'
import { clearSession, setSession } from '@/api/tokenStore'
import type { User } from '@/api/types'
import { mockAdmin, mockManager } from '@/mocks/currentUser'
import { AGENCY_ID, AGENCY_ID_RABAT } from '@/mocks/fixtures/people'
import { resetUserStore } from '@/mocks/userStore'
import { resetEmployeeStore } from '@/mocks/employeeStore'
import '@/mocks'

/**
 * Every test here signs in as an ADMIN, because that is the only role this
 * screen can be reached with: the whole /api/users router is ADMIN-only.
 *
 * It used to sign in through the provider, which meant a MANAGER - the role the
 * login fixture hands out on the default scenario - and the suite passed
 * because the fixtures answered anyone. They enforce roles now (mocks/roles.ts),
 * so testing this screen as a manager would only ever assert the refusal state,
 * which is its own test at the bottom of this file.
 *
 * The session is supplied two ways at once and needs both: SessionContext is
 * what the component reads for "(you)" and for the role locks, and tokenStore
 * is what the fixtures read to decide whether the request is allowed - the
 * stand-in for the bearer token the backend would authorise against.
 */
function renderAs(user: User) {
  setSession({ accessToken: 'FIXTURE.ACCESS', refreshToken: 'FIXTURE.REFRESH', user })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext
        value={{
          status: 'authenticated',
          user,
          signIn: async () => {},
          signOut: () => {},
        }}
      >
        <ScopeProvider>
          <MemoryRouter>
            <Users />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const renderScreen = () => renderAs(mockAdmin())

const TABLE_WAIT = { timeout: 4000 }

describe('Users', () => {
  beforeEach(() => {
    resetUserStore()
    resetEmployeeStore()
  })

  afterEach(clearSession)

  it('lists the accounts', async () => {
    renderScreen()
    expect(await screen.findByRole('table', {}, TABLE_WAIT)).toBeInTheDocument()
    /* Twice over: once as the account, once as the employee it is linked to.
       That duplication is the point - the two columns describe the same
       person from different sides. */
    expect(screen.getAllByText('Leila Fassi').length).toBe(2)
  })

  /* An account with no employee is legal - a login need not be a person with a
     card - and a blank cell would read as missing data rather than as a fact. */
  it('says when an account has no linked employee', async () => {
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)
    expect(screen.getAllByText('Not linked').length).toBeGreaterThan(0)
  })

  /**
   * Nobody is made an admin from this application (2026-08-20), so ADMIN is
   * absent from both role pickers - the create form and the table.
   *
   * The way in matters as much as the way out: locking the admin rows while
   * leaving ADMIN in a dropdown would have left one direction open, and a
   * promotion nobody could reverse from here is the worse trap of the two.
   */
  it('does not offer ADMIN when creating an account', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    await user.click(screen.getByRole('button', { name: /add account/i }))
    const dialog = screen.getByRole('dialog')

    const roles = within(dialog).getByLabelText(/^role/i)
    expect(within(roles).queryByRole('option', { name: 'ADMIN' })).not.toBeInTheDocument()
    expect(within(roles).getByRole('option', { name: 'MANAGER' })).toBeInTheDocument()
    /* Every role left needs a branch, so the picker is always there now. */
    expect(within(dialog).getByLabelText(/^agency/i)).toBeInTheDocument()
  })

  it('creates an account and shows it in the list', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    await user.click(screen.getByRole('button', { name: /add account/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/full name/i), 'Nour Sabri')
    await user.type(within(dialog).getByLabelText(/email/i), 'nour@agency.com')
    await user.type(within(dialog).getByLabelText(/^password/i), 'password123')
    await user.selectOptions(within(dialog).getByLabelText(/^role/i), 'SECURITY')

    /* Same race as the agency select fixed elsewhere in this file: this
       dialog's agency options come from the same GET /api/agencies query,
       with its own random mock latency, so the control can exist before
       AGENCY_ID is one of its options. */
    const agencySelect = within(dialog).getByLabelText(/^agency/i)
    await waitFor(() => {
      expect(within(agencySelect).getAllByRole('option').length).toBeGreaterThan(1)
    }, TABLE_WAIT)

    await user.selectOptions(agencySelect, AGENCY_ID)
    await user.click(within(dialog).getByRole('button', { name: /create account/i }))

    await waitFor(() => {
      expect(screen.getByText('Nour Sabri')).toBeInTheDocument()
    }, TABLE_WAIT)
  })

  it('explains a duplicate email in words someone can act on', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    await user.click(screen.getByRole('button', { name: /add account/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/full name/i), 'Nour Sabri')
    /* Already belongs to the seeded MANAGER. */
    await user.type(within(dialog).getByLabelText(/email/i), 'leila@agency.com')
    await user.type(within(dialog).getByLabelText(/^password/i), 'password123')

    const agencySelect = within(dialog).getByLabelText(/^agency/i)
    await waitFor(() => {
      expect(within(agencySelect).getAllByRole('option').length).toBeGreaterThan(1)
    }, TABLE_WAIT)

    await user.selectOptions(agencySelect, AGENCY_ID)
    await user.click(within(dialog).getByRole('button', { name: /create account/i }))

    await waitFor(() => {
      expect(screen.getByText(/that email is already in use/i)).toBeInTheDocument()
    }, TABLE_WAIT)
  })

  /**
   * Nobody's role is changed from this screen (2026-08-21).
   *
   * There is no control to lock any more - the column reports the role and
   * offers nothing. The admin-only version of this rule came first, after an
   * admin demoted their own account in the database trying to preview a
   * manager's screens; this is the whole feature going rather than a guard on
   * it, so the test is the absence of the control on every row.
   */
  it('offers no role control on any row', async () => {
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    for (const name of ['Leila Fassi', 'Admin Test', 'Nadia Cherkaoui', 'Karim Tazi']) {
      expect(screen.queryByLabelText(`Role for ${name}`)).not.toBeInTheDocument()
    }
    /* Still reported, and an admin is still marked as global. */
    expect(screen.getAllByText('MANAGER').length).toBeGreaterThan(0)
    expect(screen.getByText('Global')).toBeInTheDocument()
  })

  /* The agency IS still editable, and is the reason PATCH /access is still
     called at all - so the one remaining inline control gets a test. */
  it('still moves an account to another branch', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    /* The agency select renders as soon as the users table does, but its
       options come from a second, independent query (GET /api/agencies) with
       its own random mock latency - so the control can exist before Rabat is
       one of its options. Wait for the option itself, not just the table. */
    const agencySelect = screen.getByLabelText('Agency for Nadia Cherkaoui')
    await waitFor(() => {
      expect(within(agencySelect).getAllByRole('option').length).toBeGreaterThan(1)
    }, TABLE_WAIT)

    await user.selectOptions(agencySelect, AGENCY_ID_RABAT)

    await waitFor(() => {
      expect(screen.getByLabelText('Agency for Nadia Cherkaoui')).toHaveValue(AGENCY_ID_RABAT)
    }, TABLE_WAIT)
  })

  /**
   * One admin does not administer another (2026-08-20).
   *
   * Stricter than the API, which lets an admin edit or delete any account but
   * their own - so the screen is the only thing holding it.
   */
  it("offers no edit or delete on another admin's account", async () => {
    renderAs({ ...mockAdmin(), id: 'u-a-different-admin' })
    await screen.findByRole('table', {}, TABLE_WAIT)

    expect(screen.queryByRole('button', { name: /edit admin test/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete admin test/i })).not.toBeInTheDocument()
    /* Everyone else still has both. */
    expect(screen.getByRole('button', { name: /edit nadia cherkaoui/i })).toBeInTheDocument()
  })

  /* Your own admin row keeps Edit: a name, an email and a password are yours to
     change. Only Delete is refused there, and it stays visible-but-disabled so
     the reason has somewhere to live. */
  it('still lets an admin edit their own account', async () => {
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    expect(screen.getByRole('button', { name: /edit admin test/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete admin test/i })).toBeDisabled()
  })

  /* An admin has no agency, so there is nothing to pick from in that column. */
  it('shows no branch picker on an admin row', async () => {
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    expect(screen.queryByLabelText('Agency for Admin Test')).not.toBeInTheDocument()
    expect(screen.getByText('No branch')).toBeInTheDocument()
  })

  /* The backend answers 400 for this. Disabling it means nobody discovers the
     rule by having their own access taken away. */
  it('will not let you delete your own account', async () => {
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    expect(screen.getByRole('button', { name: /delete admin test/i })).toBeDisabled()
    expect(screen.getByText('(you)')).toBeInTheDocument()
  })

  /* Deleting an account destroys no attendance history, unlike deleting an
     employee. The two confirmations must not claim the same consequences. */
  it('says the employee record survives, then deletes', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    await user.click(screen.getByRole('button', { name: /delete mehdi ouazzani/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/attendance history are not touched/i)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /delete account/i }))

    await waitFor(() => {
      expect(screen.queryByText('Mehdi Ouazzani')).not.toBeInTheDocument()
    }, TABLE_WAIT)
  })

  /* PUT accepts no role and no agency, so the edit dialog must not show them -
     a control whose value is silently dropped is worse than no control. */
  it('omits role and agency from the edit dialog', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, TABLE_WAIT)

    await user.click(screen.getByRole('button', { name: /edit nadia cherkaoui/i }))
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).queryByLabelText(/^role/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^agency/i)).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText(/new password/i)).toHaveValue('')
  })

  /**
   * The screen a MANAGER actually gets, which until the fixtures enforced roles
   * was unreachable without a real backend.
   *
   * Found by testing on fixtures: signed in as the manager the login fixture
   * hands out by default, this screen was fully usable - table, role dropdowns,
   * delete - when GET /api/users answers her with a 403. She could promote
   * people to ADMIN in a dashboard that would never let her.
   */
  it('shows a manager the refusal state rather than the table', async () => {
    renderAs(mockManager())

    expect(await screen.findByText(/administrators only/i, {}, TABLE_WAIT)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    /* And no Add button above the refusal - POST is ADMIN-only too. */
    expect(screen.queryByRole('button', { name: /add account/i })).not.toBeInTheDocument()
  })
})
