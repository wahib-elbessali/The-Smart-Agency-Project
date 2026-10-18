import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import VisitorQueue from './VisitorQueue'
import { ScopeProvider } from '@/agency/scope'
import { SessionProvider } from '@/auth/session'
import { useSession } from '@/auth/SessionContext'
import { resetAssignmentStore } from '@/mocks/assignmentStore'
import { resetTicketStore } from '@/mocks/ticketStore'
import '@/mocks'

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
              <VisitorQueue />
            </SignIn>
          </MemoryRouter>
        </ScopeProvider>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

/* This screen is oversight only now (2026-09-05): who's covering each
   counter, and how its line is doing. Running the queue itself moved to
   AgentQueue. Counter-first rather than agent-first since 2026-09-23:
   the counter is the fixed thing, the covering
   agent rotates, so the list below is counters with a "who's covering
   this" picker each, not agents with a "which counter" picker each. */
/* Counters are grouped under their service now (one shared queue per
   service), so a counter's row is found inside its service's section. */
function serviceSection(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('section') as HTMLElement
}

describe('VisitorQueue', () => {
  beforeEach(() => {
    resetTicketStore()
    resetAssignmentStore()
  })

  /* Nadia is pre-assigned to Guichet 1 / VIR in the seed (assignmentStore.ts),
     and VIR has two seeded waiting tickets (Rachid, Khadija). Guichet 2 has
     no service assigned (ticketStore.ts's COUNTERS) so it never appears -
     it can't back an agent assignment either. */
  it('shows who is covering each counter and how many are waiting for its service', async () => {
    renderScreen()

    expect(await screen.findByText('Guichet 1', {}, WAIT)).toBeInTheDocument()
    const vir = serviceSection('Virement et consultation')
    expect(within(vir).getByText('Guichet 1')).toBeInTheDocument()
    expect(within(vir).getByText('Nadia Cherkaoui', { selector: 'p' })).toBeInTheDocument()
    expect(within(vir).getByText('2 waiting')).toBeInTheDocument()
    const ouv = serviceSection('Ouverture de compte')
    expect(within(ouv).getByText('Guichet 3')).toBeInTheDocument()
    expect(within(ouv).getByText('Nobody covering it')).toBeInTheDocument()
    expect(screen.queryByText(/guichet 2/i)).not.toBeInTheDocument()
  })

  it('moves the covering agent to a different counter', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByText('Guichet 1', {}, WAIT)

    const guichet3Select = screen.getByLabelText(/who's covering guichet 3/i)
    await waitFor(() => expect(guichet3Select).toBeEnabled(), WAIT)
    /* Nadia is currently on Guichet 1, so her option here is suffixed with
       where she already is - the move-in-progress the picker exists to
       show. */
    expect(within(guichet3Select).getByText(/nadia cherkaoui.*guichet 1/i)).toBeInTheDocument()
    await user.selectOptions(
      guichet3Select,
      within(guichet3Select).getByRole('option', { name: /nadia cherkaoui/i }),
    )

    await waitFor(() => {
      expect(
        within(serviceSection('Ouverture de compte')).getByText('Nadia Cherkaoui', {
          selector: 'p',
        }),
      ).toBeInTheDocument()
    }, WAIT)
    /* Salma Bennani is OUV's one seeded waiting ticket, and Guichet 1 goes
       back to uncovered - the same agent cannot cover both at once. */
    expect(within(serviceSection('Ouverture de compte')).getByText('1 waiting')).toBeInTheDocument()
    expect(
      within(serviceSection('Virement et consultation')).getByText('Nobody covering it'),
    ).toBeInTheDocument()
  })

  it('clears a counter back to "Nobody"', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByText('Guichet 1', {}, WAIT)

    const guichet1Select = screen.getByLabelText(/who's covering guichet 1/i)
    await waitFor(() => expect(guichet1Select).toBeEnabled(), WAIT)
    await user.selectOptions(
      guichet1Select,
      within(guichet1Select).getByRole('option', { name: 'Nobody' }),
    )

    await waitFor(() => {
      expect(
        within(serviceSection('Virement et consultation')).getByText('Nobody covering it'),
      ).toBeInTheDocument()
    }, WAIT)
    /* The waiting count is a property of the counter's service, not of
       whether anyone is currently covering it - clearing coverage does not
       make VIR's line vanish, so it's still shown. */
    expect(
      within(serviceSection('Virement et consultation')).getByText('2 waiting'),
    ).toBeInTheDocument()
  })
})
