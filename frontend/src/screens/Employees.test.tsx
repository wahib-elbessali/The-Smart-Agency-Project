import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import Employees from './Employees'
import { SessionProvider } from '@/auth/session'
import { ScopeProvider } from '@/agency/scope'
import { ScopeContext } from '@/agency/ScopeContext'
import { AGENCY_ID, AGENCY_ID_RABAT } from '@/mocks/fixtures/people'
import { useSession } from '@/auth/SessionContext'
import { resetEmployeeStore } from '@/mocks/employeeStore'
import '@/mocks'

/* Signs in through the real provider so role-dependent behaviour is exercised
   rather than stubbed - the agency picker appears for ADMIN only. */
function SignIn({ children }: { children: React.ReactNode }) {
  const { status, signIn } = useSession()
  if (status !== 'authenticated') {
    void signIn({ email: 'admin@agency.com', password: 'password123' })
    return null
  }
  return <>{children}</>
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ScopeProvider>
          <MemoryRouter>
            <SignIn>
              <Employees />
            </SignIn>
          </MemoryRouter>
        </ScopeProvider>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

/**
 * Renders with a branch already open, which ScopeProvider has no way to be
 * handed - entering one is a click, and these tests are about what the screen
 * does once it has happened. Supplying the context directly says so.
 */
function renderInsideBranch(agencyId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ScopeContext
          value={{ agencyId, agencyName: 'A branch', enter: () => {}, leave: () => {} }}
        >
          <MemoryRouter>
            <SignIn>
              <Employees />
            </SignIn>
          </MemoryRouter>
        </ScopeContext>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

describe('Employees', () => {
  beforeEach(resetEmployeeStore)

  it('lists the roster', async () => {
    renderScreen()
    expect(await screen.findByRole('table', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Hamza Benali')).toBeInTheDocument()
  })

  /* The whole roster is seeded into Casablanca, so opening it changes nothing
     visible - which is the point: a branch filter that quietly dropped rows
     belonging to the branch would be worse than none. */
  it('keeps the roster when the open branch is theirs', async () => {
    renderInsideBranch(AGENCY_ID)
    expect(await screen.findByRole('table', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Hamza Benali')).toBeInTheDocument()
  })

  it('shows an empty roster inside a branch nobody works at', async () => {
    renderInsideBranch(AGENCY_ID_RABAT)
    expect(await screen.findByText(/no employees yet/i, {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText('Hamza Benali')).not.toBeInTheDocument()
  })

  /* rfid_uid is nullable, and someone without a card cannot check in at all -
     so a blank cell would hide something that matters. */
  it('says when someone has no card rather than leaving it blank', async () => {
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })
    expect(screen.getAllByText('No card').length).toBeGreaterThan(0)
  })

  it('adds an employee and shows them in the table', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /add employee/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/first name/i), 'Nour')
    await user.type(within(dialog).getByLabelText(/last name/i), 'Sabri')
    await user.click(within(dialog).getByRole('button', { name: /create employee/i }))

    await waitFor(
      () => {
        expect(screen.getByText('Nour Sabri')).toBeInTheDocument()
      },
      { timeout: 4000 },
    )
  })

  /* Field(min_length=2) on both names - verified against the running API. A
     one-character name is a 422, so catching it here saves a round trip. */
  it('enforces the two-character minimum the schema requires', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /add employee/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/first name/i), 'A')
    await user.type(within(dialog).getByLabelText(/last name/i), 'Benali')
    await user.click(within(dialog).getByRole('button', { name: /create employee/i }))

    expect(within(dialog).getByText(/at least 2 characters/i)).toBeInTheDocument()
  })

  /* A duplicate card is the most likely failure on this form, and the raw
     "The server rejected the request (409)" says nothing about what to fix. */
  it('explains a duplicate card in words someone can act on', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /add employee/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/first name/i), 'Nour')
    await user.type(within(dialog).getByLabelText(/last name/i), 'Sabri')
    /* RFID-001 already belongs to the seeded first employee. */
    await user.type(within(dialog).getByLabelText(/rfid card/i), 'RFID-001')
    await user.click(within(dialog).getByRole('button', { name: /create employee/i }))

    await waitFor(
      () => {
        expect(screen.getByText(/already belongs to another employee/i)).toBeInTheDocument()
      },
      { timeout: 4000 },
    )
  })

  it('will not submit without the two required names', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /add employee/i }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /create employee/i }))

    expect(within(dialog).getAllByText('Required.').length).toBe(2)
  })

  /* The API hard-deletes and cascades the attendance history. Burying that
     behind a generic "are you sure" is how someone destroys records they
     needed - most people clicking delete actually want INACTIVE. */
  it('warns that deleting destroys attendance history, and offers the safe path', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /delete hamza benali/i }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/deletes their entire attendance history/i)).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: /set to inactive instead/i }),
    ).toBeInTheDocument()
  })

  it('removes an employee once the deletion is confirmed', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 4000 })

    await user.click(screen.getByRole('button', { name: /delete hamza benali/i }))
    await user.click(screen.getByRole('button', { name: /delete permanently/i }))

    await waitFor(
      () => {
        expect(screen.queryByText('Hamza Benali')).not.toBeInTheDocument()
      },
      { timeout: 4000 },
    )
  })
})
