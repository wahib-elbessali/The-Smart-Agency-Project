import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppShell } from './AppShell'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { ScopeProvider, SCOPE_STORAGE_KEY } from '@/agency/scope'
import { ThemeProvider } from '@/theme/theme'
import { mockUserForRole } from '@/mocks/currentUser'
import type { Role } from '@/api/types'
import '@/mocks'

/**
 * Navigation and the URL guard, which are the same rule seen from two sides.
 *
 * A screen a role cannot use is not offered to it (2026-08-20). Hiding the link
 * alone would be half a boundary - the URL still worked - so AppShell closes
 * both, and both are tested here together for that reason.
 */
function renderShell(role: Role, initialPath = '/presence') {
  const session: SessionValue = {
    status: 'authenticated',
    user: mockUserForRole(role),
    signIn: async () => {},
    signOut: () => {},
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionContext value={session}>
          <ScopeProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route element={<AppShell />}>
                  {/* Stand-ins for the real screens: this is about which routes
                    resolve for which role, not what any of them render. */}
                  <Route path="presence" element={<p>presence screen</p>} />
                  <Route path="employees" element={<p>employees screen</p>} />
                  <Route path="agencies" element={<p>agencies screen</p>} />
                  <Route path="users" element={<p>users screen</p>} />
                  <Route path="visitors" element={<p>visitors screen</p>} />
                  <Route path="alerts" element={<p>alerts screen</p>} />
                  <Route path="cameras" element={<p>cameras screen</p>} />
                  <Route path="cameras/:id" element={<p>camera view</p>} />
                  <Route path="controls" element={<p>controls screen</p>} />
                  {/* TECHNICIAN's landing page (auth/landing.ts) - required so the
                      default-path redirect below has somewhere to land. */}
                  <Route path="devices" element={<p>devices screen</p>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </ScopeProvider>
        </SessionContext>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

const navLink = (name: RegExp) => screen.queryByRole('link', { name })

describe('AppShell navigation', () => {
  it('offers an admin everything', () => {
    renderShell('ADMIN')
    expect(navLink(/user accounts/i)).toBeInTheDocument()
    expect(navLink(/agencies/i)).toBeInTheDocument()
    expect(navLink(/employee presence/i)).toBeInTheDocument()
  })

  /* The report that started this: a manager was shown User accounts and got a
     refusal when they clicked it. The link is simply not there now. */
  it('does not offer user accounts to a manager', () => {
    renderShell('MANAGER')
    expect(navLink(/user accounts/i)).not.toBeInTheDocument()
    expect(navLink(/agencies/i)).toBeInTheDocument()
  })

  it('does not offer employees or agencies to an agent', () => {
    renderShell('AGENT')
    expect(navLink(/employees/i)).not.toBeInTheDocument()
    expect(navLink(/agencies/i)).not.toBeInTheDocument()
    expect(navLink(/visitor queue/i)).toBeInTheDocument()
  })

  /* Security reads the roster but administers nobody on it. */
  it('offers presence to security but not employees', () => {
    renderShell('SECURITY')
    expect(navLink(/employee presence/i)).toBeInTheDocument()
    expect(navLink(/employees/i)).not.toBeInTheDocument()
  })

  /* The guard's own screen. A technician registers sensors, not cameras. */
  it('offers cameras to security and not to a technician', () => {
    renderShell('SECURITY')
    expect(navLink(/cameras/i)).toBeInTheDocument()
    renderShell('TECHNICIAN')
    expect(screen.queryAllByRole('link', { name: /cameras/i })).toHaveLength(1)
  })

  it('leaves the unguarded screens for every role', () => {
    renderShell('TECHNICIAN')
    expect(navLink(/climate/i)).toBeInTheDocument()
    expect(navLink(/help/i)).toBeInTheDocument()
    expect(navLink(/settings/i)).toBeInTheDocument()
  })

  /* Controls is ADMIN, MANAGER and SECURITY - a technician registers
     devices but does not command them. */
  it('offers manual controls to security and not to a technician', () => {
    renderShell('SECURITY')
    expect(navLink(/manual controls/i)).toBeInTheDocument()
    cleanup()
    renderShell('TECHNICIAN')
    expect(screen.queryAllByRole('link', { name: /manual controls/i })).toHaveLength(0)
  })

  /* The alert streams refuse anyone outside ADMIN, MANAGER and SECURITY
     (contracts/api.md §13), so the link would lead only to a refusal. Two
     links lead there - the top bar's alerts bell on a desktop, and the nav
     entry that only the phone menu shows (CSS hides it on a desktop, which
     jsdom does not apply) - and a technician must get neither. */
  it('offers alerts to security and not to a technician', () => {
    renderShell('SECURITY')
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    expect(within(sidebar).getByRole('link', { name: /alerts/i })).toBeInTheDocument()
    cleanup()
    renderShell('TECHNICIAN')
    expect(screen.queryAllByRole('link', { name: /alerts/i })).toHaveLength(0)
  })
})

describe('AppShell URL guard', () => {
  it('redirects a manager who types the users URL to their own start screen', () => {
    renderShell('MANAGER', '/users')

    expect(screen.queryByText('users screen')).not.toBeInTheDocument()
    /* A manager starts on presence, so that is where they land. */
    expect(screen.getByText('presence screen')).toBeInTheDocument()
  })

  it('redirects an agent away from employees', () => {
    renderShell('AGENT', '/employees')

    expect(screen.queryByText('employees screen')).not.toBeInTheDocument()
    expect(screen.getByText('visitors screen')).toBeInTheDocument()
  })

  /* The nested path has no entry of its own and inherits /cameras - the
     fallback in access.ts, which this is the test that it still works. */
  it('guards the live view under cameras the same as the list', () => {
    renderShell('AGENT', '/cameras/some-id')
    expect(screen.getByText('visitors screen')).toBeInTheDocument()
  })

  it('sends an agent who types the cameras URL to the visitor queue', () => {
    renderShell('AGENT', '/cameras')

    expect(screen.queryByText('cameras screen')).not.toBeInTheDocument()
    expect(screen.getByText('visitors screen')).toBeInTheDocument()
  })

  it('lets an allowed URL through untouched', () => {
    renderShell('ADMIN', '/users')
    expect(screen.getByText('users screen')).toBeInTheDocument()
  })
})

describe('AppShell branch picker after a reload', () => {
  const stored = (id: string, name: string) =>
    sessionStorage.setItem(
      SCOPE_STORAGE_KEY,
      JSON.stringify({ userId: mockUserForRole('ADMIN').id, id, name }),
    )

  it('keeps the branch an admin had chosen', async () => {
    stored('a1000000-0000-4000-8000-000000000001', 'Agence Casablanca')
    renderShell('ADMIN')
    expect(
      await screen.findByText(/Everything below is Agence Casablanca only/i),
    ).toBeInTheDocument()
  })

  it('lets go of a remembered branch that no longer exists, instead of asking every screen for it', async () => {
    stored('a-branch-that-was-deleted', 'Ghost branch')
    renderShell('ADMIN')
    expect(await screen.findByText(/Everything below is Ghost branch only/i)).toBeInTheDocument()
    /* The branch list has to arrive before the shell can tell the branch is gone. */
    await waitFor(
      () => expect(screen.getByText(/Looking at every branch at once/i)).toBeInTheDocument(),
      { timeout: 4000 },
    )
    expect(sessionStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull()
  })
})
