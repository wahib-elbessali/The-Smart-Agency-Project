import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import TicketTemplate from './TicketTemplate'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import { AGENCY_ID } from '@/mocks/fixtures/people'
import { resetAgencyStore } from '@/mocks/agencyStore'
import { resetTicketTemplateStore } from '@/mocks/fixtures/ticketTemplate'
import '@/mocks'

function renderScreen() {
  const session: SessionValue = {
    status: 'authenticated',
    user: {
      id: 'u-test',
      full_name: 'Manager',
      email: 'm@agency.com',
      role: 'MANAGER',
      agency_id: AGENCY_ID,
      is_active: true,
    },
    signIn: async () => {},
    signOut: () => {},
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext value={session}>
        <ScopeProvider>
          <MemoryRouter>
            <TicketTemplate />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }
const preview = () => screen.getByLabelText('Ticket preview')

describe('TicketTemplate', () => {
  beforeEach(() => {
    resetAgencyStore()
    resetTicketTemplateStore()
  })

  it('shows the layout a branch has and a preview of it', async () => {
    renderScreen()
    expect(
      await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT),
    ).toBeInTheDocument()
    expect(within(preview()).getByText('Bienvenue chez nous')).toBeInTheDocument()
    expect(within(preview()).getByText('20261002-VIR-001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('will not save a block that would print nothing, and says which one', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT)
    await user.click(screen.getByRole('button', { name: /add text block/i }))
    expect(await screen.findByText(/Block 6 \(text\) is empty/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('saves an edit and keeps it after a reload of the layout', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT)
    await user.click(screen.getByRole('button', { name: /add text block/i }))
    await user.type(screen.getByLabelText(/Text content, block 6/i), 'Merci de votre visite')
    expect(within(preview()).getByText('Merci de votre visite')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/Saved\. The kiosk will print/i, {}, WAIT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(within(preview()).getByText('Merci de votre visite')).toBeInTheDocument()
  })

  it('reorders blocks and the preview follows', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT)
    await user.click(screen.getByRole('button', { name: /move block 1, text down/i }))
    const lines = Array.from(preview().querySelectorAll('p')).map((p) => p.textContent)
    expect(lines[0]).not.toBe('Bienvenue chez nous')
    expect(lines[1]).toBe('Bienvenue chez nous')
    expect(screen.getByRole('button', { name: /move block 1, branch name up/i })).toBeDisabled()
  })

  it('removes a block, and can go back to the default layout or discard', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT)
    await user.click(screen.getByRole('button', { name: /remove block 5, date/i }))
    expect(screen.queryByRole('button', { name: /remove block 5/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /reset to default/i }))
    expect(screen.getByRole('button', { name: /remove block 5, date/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /remove block 1, text/i }))
    await user.click(screen.getByRole('button', { name: /discard changes/i }))
    expect(screen.getByRole('button', { name: /remove block 1, text/i })).toBeInTheDocument()
  })

  it('refuses to save an empty ticket', async () => {
    const user = userEvent.setup()
    renderScreen()
    await screen.findByRole('button', { name: /move block 1, text down/i }, WAIT)
    for (let i = 0; i < 5; i += 1) {
      await user.click(screen.getAllByRole('button', { name: /^remove block/i })[0] as HTMLElement)
    }
    expect(await screen.findByText(/Add at least one block/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByText('Nothing to print.')).toBeInTheDocument()
  })
})
