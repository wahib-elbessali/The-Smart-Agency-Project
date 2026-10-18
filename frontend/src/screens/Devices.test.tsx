import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import Devices from './Devices'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import { resetDeviceStore } from '@/mocks/deviceStore'
import { mockUserForRole } from '@/mocks/currentUser'
import '@/mocks'

function renderScreen() {
  const session: SessionValue = {
    status: 'authenticated',
    user: mockUserForRole('MANAGER'),
    signIn: async () => {},
    signOut: () => {},
  }
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionContext value={session}>
        <ScopeProvider>
          <MemoryRouter>
            <Devices />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

describe('Devices', () => {
  afterEach(() => resetDeviceStore())

  /* 2026-10-18 day test: one stray click rotated a door reader's key and took
     it offline. Rotating now asks first, and says what it does. */
  it('asks before rotating a key, and only then shows the new one', async () => {
    const user = userEvent.setup()
    renderScreen()
    const [rotate] = await screen.findAllByRole('button', { name: /Rotate key for/ })
    await user.click(rotate)

    const confirm = await screen.findByRole('dialog')
    expect(within(confirm).getByText(/stops working immediately/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(rotate)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rotate key' }),
    )
    // the key dialog's text exists only once it has opened
    expect(await screen.findByText(/Shown once/)).toBeInTheDocument()
  })
})
