import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import AgencyDetail from './AgencyDetail'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import type { User } from '@/api/types'
import { AGENCY_ID } from '@/mocks/fixtures/people'
import { resetAgencyStore } from '@/mocks/agencyStore'
import '@/mocks'

function renderAs(role: User['role']) {
  const session: SessionValue = {
    status: 'authenticated',
    user: {
      id: 'u-test',
      full_name: 'Test',
      email: 'test@agency.com',
      role,
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
          <MemoryRouter initialEntries={[`/agencies/${AGENCY_ID}`]}>
            <Routes>
              <Route path="/agencies/:id" element={<AgencyDetail />} />
            </Routes>
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('AgencyDetail weapon lockdown', () => {
  beforeEach(resetAgencyStore)

  it('is notify-only by default and a manager can switch it on and off again', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    expect(await screen.findByText('Notify only', {}, WAIT)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /enable automatic lockdown/i }))
    expect(await screen.findByText('Automatic', {}, WAIT)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /switch to notify only/i }))
    expect(await screen.findByText('Notify only', {}, WAIT)).toBeInTheDocument()
  })

  it('warns about fire-egress rules before anyone enables it', async () => {
    renderAs('MANAGER')
    expect(await screen.findByText(/fire-egress rules/i, {}, WAIT)).toBeInTheDocument()
  })

  it('shows state but no switch to a role that cannot write', async () => {
    renderAs('SECURITY')
    expect(await screen.findByText('Notify only', {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable automatic lockdown/i })).toBeNull()
  })
})
