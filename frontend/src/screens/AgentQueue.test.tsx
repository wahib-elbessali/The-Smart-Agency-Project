import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentQueue from './AgentQueue'
import { SessionProvider } from '@/auth/session'
import { useSession } from '@/auth/SessionContext'
import { assignAgent, resetAssignmentStore } from '@/mocks/assignmentStore'
import { resetTicketStore } from '@/mocks/ticketStore'
import '@/mocks'

function SignIn({ children }: { children: React.ReactNode }) {
  const { status, signIn } = useSession()
  if (status !== 'authenticated') {
    void signIn({ email: 'nadia@agency.com', password: 'password123' })
    return null
  }
  return <>{children}</>
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <MemoryRouter>
          <SignIn>
            <AgentQueue />
          </SignIn>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

/* "Nobody yet" is on screen from the first render regardless of whether the
   queue has loaded, so it is not a signal that Next is usable yet - the
   button starts disabled until the queue query resolves and finds someone
   waiting. Wait on the button itself, the same pattern VisitorQueue.test.tsx
   uses for Call. */
async function enabledNext() {
  const button = screen.getByRole('button', { name: /^next$/i })
  await waitFor(() => expect(button).toBeEnabled(), WAIT)
  return button
}

describe('AgentQueue', () => {
  beforeEach(() => {
    resetTicketStore()
    resetAssignmentStore()
  })

  /* Nadia is pre-assigned to Guichet 1 / Virement et consultation in the seed
     (assignmentStore.ts) - there is no picker to click through any more. */
  it('goes straight to serving the assigned service, no picker', async () => {
    renderScreen()

    expect(await screen.findByText('Virement et consultation', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('Nobody yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ouverture de compte' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Guichet 1' })).not.toBeInTheDocument()

    /* Both of VIR's seeded waiting tickets are visible behind whoever is
       current - visibility, not just a count. */
    await screen.findByText('Rachid El Fassi', {}, WAIT)
    expect(screen.getByText('Khadija Moussaoui')).toBeInTheDocument()
  })

  it('calls the next waiting ticket, then completes it with a note and calls the one after', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByText('Virement et consultation', {}, WAIT)

    /* Rachid and Khadija are VIR's two seeded waiting tickets, oldest first.
     * Waiting on the notes field rather than Rachid's name: his name is
     * already on screen in the "Behind them" list before anyone is called,
     * so it is not proof the click's mutation actually finished - the notes
     * field only renders once `current` is set, which is. */
    await user.click(await enabledNext())
    await screen.findByLabelText(/notes/i, {}, WAIT)
    /* Rachid moved from "behind" to "now serving" - only Khadija is left
         behind him. Waited on the count rather than checked immediately: the
         queue refetch that drops him from "Behind them" is a separate,
         slightly later state update than the one that set `current`. */
    await waitFor(() => expect(screen.getByText('1 person')).toBeInTheDocument(), WAIT)
    expect(screen.getByText('Rachid El Fassi')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/notes/i), 'Wanted a wire transfer, all good.')
    await user.click(await enabledNext())
    await waitFor(
      () => expect(screen.getByText(/nobody else is waiting/i)).toBeInTheDocument(),
      WAIT,
    )
    expect(screen.getByText('Khadija Moussaoui')).toBeInTheDocument()
    expect(screen.queryByText('Rachid El Fassi')).not.toBeInTheDocument()
    /* The note field clears for the next person rather than carrying over. */
    expect(screen.getByLabelText(/notes/i)).toHaveValue('')

    /* Nobody left after Khadija - Next finishes her and has nobody to call. */
    await user.click(await enabledNext())
    await waitFor(() => expect(screen.getByText('Nobody yet')).toBeInTheDocument(), WAIT)
  }, 20_000)

  it('tells an unassigned agent to ask their manager, with no picker to fall back on', async () => {
    /* Overwrite the seed as if nobody has assigned this agent yet. */
    assignAgent('u1000000-0000-4000-8000-000000000005', null)

    renderScreen()

    expect(
      await screen.findByText(/hasn't put you on a counter yet/i, {}, WAIT),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument()
  })
})
