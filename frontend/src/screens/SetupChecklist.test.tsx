import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupChecklist } from './SetupChecklist'
import * as endpoint from '@/api/endpoints/setupStatus'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { mockUserForRole } from '@/mocks/currentUser'
import type { Role, SetupStatus } from '@/api/types'
import '@/mocks'

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
        <MemoryRouter>
          <SetupChecklist agencyId="a1" />
        </MemoryRouter>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('SetupChecklist', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows progress, the steps by group, and why a missing step matters', async () => {
    renderAs('MANAGER')
    expect(await screen.findByText('4 of 7', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('4 of 7 done · 2 to do · 1 could not be checked')).toBeInTheDocument()
    expect(screen.getByText(/Foundation · 3\/3/)).toBeInTheDocument()
    expect(
      screen.getByText(/Still the generic default - Until then every ticket prints/),
    ).toBeInTheDocument()
  })

  it('treats a step the AI service could not answer as "could not check", not as undone', async () => {
    renderAs('MANAGER')
    await screen.findByText('4 of 7', {}, WAIT)
    expect(screen.getByLabelText('Could not check')).toBeInTheDocument()
    expect(screen.getByText(/the AI service did not answer/i)).toBeInTheDocument()
    expect(screen.getAllByLabelText('Not done yet')).toHaveLength(2)
    expect(screen.getAllByLabelText('Done')).toHaveLength(4)
  })

  it('links a step to its screen when the role can reach it', async () => {
    renderAs('MANAGER')
    await screen.findByText('4 of 7', {}, WAIT)
    expect(screen.getByRole('link', { name: 'Ticket layout customised' })).toHaveAttribute(
      'href',
      '/ticket-template',
    )
  })

  it('does not link a step the role cannot open, and says who can', async () => {
    const withUsers: SetupStatus = {
      items: [
        {
          key: 'logins',
          group: 'People',
          label: 'An agent login exists',
          why: 'Agents serve the queue.',
          status: 'todo',
          detail: '0 active agent accounts',
          link: '/users',
        },
      ],
      done: 0,
      total: 1,
      complete: false,
    }
    vi.spyOn(endpoint, 'fetchSetupStatus').mockResolvedValue(withUsers)
    renderAs('MANAGER')
    await screen.findByText('0 of 1', {}, WAIT)
    expect(screen.queryByRole('link', { name: 'An agent login exists' })).not.toBeInTheDocument()
    expect(screen.getByText('ask an administrator')).toBeInTheDocument()
  })

  it('can be hidden and shown again while work is left', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')
    await screen.findByText('4 of 7', {}, WAIT)
    expect(screen.getByText(/Foundation · 3\/3/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hide/i }))
    expect(screen.queryByText(/Foundation · 3\/3/)).not.toBeInTheDocument()
    expect(screen.getByText('4 of 7 done · 2 to do · 1 could not be checked')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show/i }))
    expect(screen.getByText(/Foundation · 3\/3/)).toBeInTheDocument()
  })

  it('tucks itself away once everything is done, and can still be opened', async () => {
    const user = userEvent.setup()
    vi.spyOn(endpoint, 'fetchSetupStatus').mockResolvedValue({
      items: [
        {
          key: 'hours',
          group: 'Foundation',
          label: 'Opening hours set',
          why: '',
          status: 'done',
          detail: 'Set',
          link: '/agencies',
        },
      ],
      done: 1,
      total: 1,
      complete: true,
    })
    renderAs('ADMIN')
    expect(await screen.findByText('1 of 1', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('Everything is set up.')).toBeInTheDocument()
    expect(screen.queryByText('Opening hours set')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show/i }))
    expect(screen.getByText('Opening hours set')).toBeInTheDocument()
  })

  it('is simply absent when the checklist cannot be loaded', async () => {
    vi.spyOn(endpoint, 'fetchSetupStatus').mockRejectedValue(new Error('down'))
    const { container } = renderAs('MANAGER')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(container).toBeEmptyDOMElement()
  })
})
