import { MOCK_SCENARIO } from '@/api/config'
import { getSession } from '@/api/tokenStore'
import type { Role, User } from '@/api/types'
import { AGENCY_ID, AGENCY_ID_RABAT } from './fixtures/people'

/**
 * Who is making the request, in mock mode.
 *
 * Until now nothing outside the auth fixtures could read this, so every other
 * fixture answered as though an ADMIN were asking. That is wrong in the
 * direction the mock layer explicitly refuses to be wrong in (userStore.ts):
 * signing in with anything other than one of the five seeded emails below
 * lands you on a MANAGER by default, and a MANAGER's reads are scoped
 * server-side. Handing them rows the real API filters out lets a screen be
 * built against a list that cannot happen.
 *
 * Kept in its own module rather than exported from fixtures/auth.ts, because
 * that file registers mocks as a module side effect and a store importing it
 * would drag the auth endpoints along with it.
 */

export function mockManager(): User {
  return {
    id: 'u1000000-0000-4000-8000-000000000001',
    full_name: 'Leila Fassi',
    email: 'leila@agency.com',
    role: 'MANAGER',
    agency_id: AGENCY_ID,
    is_active: true,
  }
}

export function mockAdmin(): User {
  return {
    id: 'u1000000-0000-4000-8000-000000000002',
    full_name: 'Admin Test',
    email: 'admin@test.com',
    role: 'ADMIN',
    agency_id: null,
    is_active: true,
  }
}

/**
 * One signed-in user per role, for the fixture-mode "viewing as" switch.
 *
 * Each is a real row from userStore's seed rather than an invented person, so
 * switching to SECURITY makes you Mehdi - an account that appears in the
 * account list, belongs to a branch, and has an employee behind it. A made-up
 * user would be scoped against agencies and employees that do not know them.
 *
 * The ids match the seed for the same reason: "(you)" and the disabled
 * delete-yourself button key off the id, and they should point at a real row.
 */
const MOCK_USERS: Record<Role, User> = {
  ADMIN: mockAdmin(),
  MANAGER: mockManager(),
  SECURITY: {
    id: 'u1000000-0000-4000-8000-000000000003',
    full_name: 'Mehdi Ouazzani',
    email: 'mehdi@agency.com',
    role: 'SECURITY',
    agency_id: AGENCY_ID,
    is_active: true,
  },
  TECHNICIAN: {
    id: 'u1000000-0000-4000-8000-000000000004',
    full_name: 'Karim Tazi',
    email: 'karim@agency.com',
    role: 'TECHNICIAN',
    /* The one seeded account in Rabat, which makes it the useful one for
       checking that a scoped screen follows the account rather than a default. */
    agency_id: AGENCY_ID_RABAT,
    is_active: true,
  },
  AGENT: {
    id: 'u1000000-0000-4000-8000-000000000005',
    full_name: 'Nadia Cherkaoui',
    email: 'nadia@agency.com',
    role: 'AGENT',
    agency_id: AGENCY_ID,
    is_active: true,
  },
}

export function mockUserForRole(role: Role): User {
  return { ...MOCK_USERS[role] }
}

/**
 * Which seeded account the login screen hands out for a typed email -
 * case-insensitively and trimmed, since a person testing this by hand will not
 * always match the seed's casing exactly.
 *
 * This is what makes "sign in as admin@test.com" vs "sign in as
 * leila@agency.com" actually produce two different roles in ONE running app,
 * on the SAME login form - which is what a person testing role differences by
 * hand expects the moment credentials exist at all. Passwords are still
 * ignored; only the email is read.
 *
 * An email that matches none of the five seeded accounts falls back to the
 * MANAGER, the same default `currentMockUser()` used before this existed -
 * so typing throwaway credentials like "test@test.com" still gets you in.
 */
export function mockUserForEmail(email: string): User {
  const normalized = email.trim().toLowerCase()
  const match = Object.values(MOCK_USERS).find((user) => user.email.toLowerCase() === normalized)
  return match ? { ...match } : mockManager()
}

/**
 * The user the login fixtures hand out when nothing else is known - the
 * default before email is read, and what backs 'GET /api/auth/me' when no
 * session exists to ask instead.
 */
export function currentMockUser(): User {
  return MOCK_SCENARIO === 'normal' ? mockManager() : mockAdmin()
}

/**
 * The user a fixture should scope its answer to, or null to scope nothing.
 *
 * Read from tokenStore rather than from MOCK_SCENARIO, because the scenario is
 * a module constant fixed at import time and the session is not: a test can
 * render a screen as an ADMIN while the scenario says MANAGER, and scoping the
 * data by the scenario would then answer a question nobody asked. The session
 * is also the honest analogue - the backend scopes by the user behind the
 * bearer token, and this is where that token lives.
 *
 * Null means unscoped, which is the ADMIN view. That is the right default for
 * the two cases that produce it: a test supplying SessionContext directly
 * without going through setSession, and a request made before sign-in, which
 * the real API would answer with a 401 rather than a filtered list.
 */
export function requestUser(): User | null {
  return getSession()?.user ?? null
}
