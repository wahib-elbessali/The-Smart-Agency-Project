import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import ManualControls from './ManualControls'
import { sendControlCommand } from '@/api/endpoints/controls'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider } from '@/agency/scope'
import { mockUserForRole } from '@/mocks/currentUser'

vi.mock('@/api/endpoints/devices', () => ({
  fetchDevices: vi.fn(async () => [
    {
      id: 'd1',
      agency_id: 'a1',
      name: 'Access sensors 1',
      device_type: 'ACCESS_SENSORS',
      mqtt_client_id: 'access-sensors-1',
    },
    {
      id: 'd2',
      agency_id: 'a1',
      name: 'Borne tickets',
      device_type: 'TICKET_KIOSK',
      mqtt_client_id: 'ticket-kiosk-01',
    },
  ]),
}))
vi.mock('@/api/endpoints/controls', () => ({
  fetchControlCommands: vi.fn(async () => ({
    ACCESS_SENSORS: [
      { action: 'lock', label: 'Lock' },
      { action: 'unlock', label: 'Unlock' },
    ],
  })),
  sendControlCommand: vi.fn(async () => ({ status: 'confirmed', detail: 'door unlocked' })),
}))

function renderScreen() {
  const session: SessionValue = {
    status: 'authenticated',
    user: mockUserForRole('SECURITY'),
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
            <ManualControls />
          </MemoryRouter>
        </ScopeProvider>
      </SessionContext>
    </QueryClientProvider>,
  )
}

describe('ManualControls', () => {
  it('offers only the commands a device takes, as buttons', async () => {
    renderScreen()
    const door = (await screen.findByRole('heading', { name: 'Access sensors 1' })).closest(
      'section',
    )!
    await userEvent.click(within(door).getByRole('button', { name: 'Unlock' }))

    expect(sendControlCommand).toHaveBeenCalledWith('d1', { action: 'unlock' })
    expect(await within(door).findByText(/Confirmed · door unlocked/)).toBeInTheDocument()
    expect(within(door).queryByRole('textbox')).not.toBeInTheDocument()
    // the kiosk takes no commands: no card, just named as running on its own
    expect(screen.queryByRole('heading', { name: 'Borne tickets' })).not.toBeInTheDocument()
    expect(screen.getByText(/No manual commands for Borne tickets/)).toBeInTheDocument()
  })
})
