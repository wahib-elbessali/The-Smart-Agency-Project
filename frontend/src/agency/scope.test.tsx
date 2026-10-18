import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopeProvider, SCOPE_STORAGE_KEY } from './scope'
import { useScope, withinScope } from './ScopeContext'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { mockUserForRole } from '@/mocks/currentUser'
import { AGENCY_ID, AGENCY_ID_RABAT } from '@/mocks/fixtures/people'
import type { Role } from '@/api/types'

/**
 * The branch an admin is working inside.
 *
 * A view filter, not a permission - which is what most of these tests are
 * really about. It must do nothing for the roles whose data the backend already
 * scopes, it must do nothing until somebody asks for it, and it must let go the
 * moment the session changes underneath it.
 */
function Probe() {
  const scope = useScope()
  return (
    <div>
      <span data-testid="scope">{scope.agencyId ?? 'none'}</span>
      <span data-testid="name">{scope.agencyName ?? 'none'}</span>
      <button onClick={() => scope.enter({ id: AGENCY_ID, name: 'Agence Casablanca' })}>
        enter
      </button>
      <button onClick={scope.leave}>leave</button>
    </div>
  )
}

function renderAs(role: Role) {
  const session: SessionValue = {
    status: 'authenticated',
    user: mockUserForRole(role),
    signIn: async () => {},
    signOut: () => {},
  }
  return render(
    <SessionContext value={session}>
      <ScopeProvider>
        <Probe />
      </ScopeProvider>
    </SessionContext>,
  )
}

describe('ScopeProvider', () => {
  it('starts with nothing scoped', () => {
    renderAs('ADMIN')
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
  })

  it('holds the branch an admin enters, and lets it go again', async () => {
    const user = userEvent.setup()
    renderAs('ADMIN')

    await user.click(screen.getByRole('button', { name: 'enter' }))
    expect(screen.getByTestId('scope')).toHaveTextContent(AGENCY_ID)
    expect(screen.getByTestId('name')).toHaveTextContent('Agence Casablanca')

    await user.click(screen.getByRole('button', { name: 'leave' }))
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
  })

  /**
   * The rule that keeps this a lens rather than a boundary.
   *
   * A MANAGER's rows arrive already filtered by the backend. Filtering them
   * again here would be the frontend enforcing someone else's boundary, and if
   * the held branch were ever not theirs it would quietly show them nothing.
   */
  it('does nothing for a manager, even if a branch is held', async () => {
    const user = userEvent.setup()
    renderAs('MANAGER')

    await user.click(screen.getByRole('button', { name: 'enter' }))

    expect(screen.getByTestId('scope')).toHaveTextContent('none')
    expect(screen.getByTestId('name')).toHaveTextContent('none')
  })

  it('answers for a tree with no session at all', () => {
    render(
      <ScopeProvider>
        <Probe />
      </ScopeProvider>,
    )
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
  })
})

describe('withinScope', () => {
  const rows = [
    { id: 'a', agency_id: AGENCY_ID },
    { id: 'b', agency_id: AGENCY_ID_RABAT },
    { id: 'c', agency_id: AGENCY_ID },
  ]

  /* It must, or an admin who never opened a branch would see nothing at all. */
  it('returns everything when no branch is open', () => {
    expect(withinScope(rows, null)).toHaveLength(3)
  })

  it('keeps only the branch that is open', () => {
    expect(withinScope(rows, AGENCY_ID).map((row) => row.id)).toEqual(['a', 'c'])
  })

  it('returns nothing for a branch with no rows, rather than everything', () => {
    expect(withinScope(rows, 'a-branch-with-nobody-in-it')).toEqual([])
  })
})

describe('ScopeProvider across a page reload', () => {
  afterEach(() => sessionStorage.clear())

  const sessionFor = (role: Role, id?: string): SessionValue => {
    const user = mockUserForRole(role)
    return {
      status: 'authenticated',
      user: id ? { ...user, id } : user,
      signIn: async () => {},
      signOut: () => {},
    }
  }

  /* A reload is a fresh mount against the same sessionStorage. */
  const mount = (session: SessionValue) =>
    render(
      <SessionContext value={session}>
        <ScopeProvider>
          <Probe />
        </ScopeProvider>
      </SessionContext>,
    )

  it('keeps the branch an admin chose after a reload', async () => {
    const user = userEvent.setup()
    const admin = sessionFor('ADMIN', 'admin-1')
    const first = mount(admin)
    await user.click(screen.getByRole('button', { name: 'enter' }))
    expect(screen.getByTestId('scope')).toHaveTextContent(AGENCY_ID)
    first.unmount()

    mount(admin)
    expect(screen.getByTestId('scope')).toHaveTextContent(AGENCY_ID)
    expect(screen.getByTestId('name')).toHaveTextContent('Agence Casablanca')
  })

  it('does not hand one person the branch another chose on the same tab', async () => {
    const user = userEvent.setup()
    const first = mount(sessionFor('ADMIN', 'admin-1'))
    await user.click(screen.getByRole('button', { name: 'enter' }))
    first.unmount()

    mount(sessionFor('ADMIN', 'admin-2'))
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
  })

  it('forgets the branch when the person signs out, and when it is left', async () => {
    const user = userEvent.setup()
    const admin = sessionFor('ADMIN', 'admin-1')
    const first = mount(admin)
    await user.click(screen.getByRole('button', { name: 'enter' }))
    expect(sessionStorage.getItem(SCOPE_STORAGE_KEY)).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'leave' }))
    expect(sessionStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'enter' }))
    first.rerender(
      <SessionContext value={{ ...admin, status: 'anonymous', user: null }}>
        <ScopeProvider>
          <Probe />
        </ScopeProvider>
      </SessionContext>,
    )
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
    expect(sessionStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull()
  })

  it('ignores a corrupt or incomplete stored value', () => {
    for (const bad of [
      'not json',
      '{}',
      'null',
      '{"id":"x","name":"y"}',
      '{"userId":"admin-1","id":"","name":"y"}',
    ]) {
      sessionStorage.setItem(SCOPE_STORAGE_KEY, bad)
      const view = mount(sessionFor('ADMIN', 'admin-1'))
      expect(screen.getByTestId('scope')).toHaveTextContent('none')
      view.unmount()
    }
  })

  it('still never applies a stored branch to a manager', () => {
    sessionStorage.setItem(
      SCOPE_STORAGE_KEY,
      JSON.stringify({ userId: 'mgr-1', id: AGENCY_ID, name: 'Agence Casablanca' }),
    )
    mount(sessionFor('MANAGER', 'mgr-1'))
    expect(screen.getByTestId('scope')).toHaveTextContent('none')
  })
})
