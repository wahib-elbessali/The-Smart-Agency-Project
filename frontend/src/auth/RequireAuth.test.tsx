import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequireAuth } from './RequireAuth'
import { SessionProvider } from './session'
import { useSession, type SessionValue } from './SessionContext'
import '@/mocks'

/* Captures the session so a test can sign in from outside the tree. The
   authenticated branch of the guard is only reachable through a real sign-in -
   there is no way to hand it a session directly, and faking one would test a
   provider that does not exist. */
let session: SessionValue | null = null

function CaptureSession() {
  session = useSession()
  return null
}

/* Stands in for src/screens/Login, which reads the same location state to send
   you back where you were headed. */
function LoginStub() {
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/presence'
  return (
    <>
      <p>login screen</p>
      <p>bounced from {from}</p>
      <Link to={from}>continue</Link>
    </>
  )
}

/* `capture` is off for the rebuilt-module tests below. CaptureSession is bound
   to the statically imported SessionContext, and a rebuilt graph brings its own
   - mounting it under the rebuilt provider reads a context nobody published to
   and throws. Those tests do not need the session anyway. */
function renderGuarded({ Guard = RequireAuth, Provider = SessionProvider, capture = true } = {}) {
  return render(
    <Provider>
      {capture && <CaptureSession />}
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route
            path="/secret"
            element={
              <Guard>
                <p>protected content</p>
              </Guard>
            }
          />
          <Route path="/login" element={<LoginStub />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

afterEach(() => {
  session = null
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('RequireAuth', () => {
  /* Enforcement is on by default now. It was off for a while, and the cost of
     that was not theoretical: a fresh clone with no .env.local walked into every
     screen without ever seeing a login, and looked like it was working. */
  it('sends an anonymous visitor to the login screen', () => {
    renderGuarded()
    expect(screen.getByText('login screen')).toBeInTheDocument()
    expect(screen.queryByText('protected content')).not.toBeInTheDocument()
  })

  it('remembers where the visitor was headed', () => {
    renderGuarded()
    expect(screen.getByText('bounced from /secret')).toBeInTheDocument()
  })

  it('admits a signed-in visitor', async () => {
    renderGuarded()

    await act(async () => {
      await session?.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })
    await userEvent.click(screen.getByRole('link', { name: 'continue' }))

    expect(screen.getByText('protected content')).toBeInTheDocument()
  })

  /* The escape hatch, kept tested because it is what someone reaches for when
     the backend is down and they want to work on a screen regardless.

     AUTH_ENFORCED is read once at module scope, so stubbing the env after the
     import has no effect - the module graph has to be rebuilt. The provider
     comes from the rebuilt graph too: a fresh RequireAuth holds a fresh
     SessionContext, and the statically imported provider would be publishing to
     the old one. */
  it('can be turned off with VITE_AUTH_ENFORCED=false', async () => {
    vi.stubEnv('VITE_AUTH_ENFORCED', 'false')
    vi.resetModules()

    const [{ RequireAuth: Unenforced }, { SessionProvider: Provider }] = await Promise.all([
      import('./RequireAuth'),
      import('./session'),
    ])

    renderGuarded({ Guard: Unenforced, Provider, capture: false })

    expect(screen.getByText('protected content')).toBeInTheDocument()
    expect(screen.queryByText('login screen')).not.toBeInTheDocument()
  })

  /* Only the exact string turns it off. Anything else - 'FALSE', '0', a typo, a
     variable someone set to empty - has to leave the guard on, because that is
     what makes a missing or malformed env file fail safe. */
  it('stays on for any value other than the exact string false', async () => {
    vi.stubEnv('VITE_AUTH_ENFORCED', 'FALSE')
    vi.resetModules()

    const [{ RequireAuth: Guard }, { SessionProvider: Provider }] = await Promise.all([
      import('./RequireAuth'),
      import('./session'),
    ])

    renderGuarded({ Guard, Provider, capture: false })

    expect(screen.getByText('login screen')).toBeInTheDocument()
  })
})
