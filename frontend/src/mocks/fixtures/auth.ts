import { registerMock, registerMockWriter } from '../registry'
import type { LoginResponse, User } from '@/api/types'
import { mockManager as manager, mockUserForEmail, requestUser } from '../currentUser'

/**
 * Field names from POST /api/auth/login and GET /api/auth/me.
 *
 * The token strings are obviously fake and are meant to look it. They are never
 * verified by anything in mock mode - the point of these fixtures is to exercise
 * the session plumbing, not to pretend to be a security boundary.
 *
 * WHICH ACCOUNT SIGNS IN comes from the email typed at the login form, via
 * mockUserForEmail() in ../currentUser - not from MOCK_SCENARIO. That used to
 * be scenario-coupled ('normal' => MANAGER, everything else => ADMIN), which
 * meant testing both roles by hand needed two separate dev servers running two
 * different scenarios. Email carries the role now, and scenario goes back to
 * doing only what scenario.ts says it is for: the shape of the DATA
 * (normal/empty/large/error), not who is signed in to look at it.
 */

function loginAs(user: User): LoginResponse {
  return {
    access_token: 'FIXTURE.ACCESS.TOKEN',
    refresh_token: 'FIXTURE.REFRESH.TOKEN',
    token_type: 'bearer',
    user,
  }
}

/* A writer, not a read variant, because the role it returns depends on the
   request BODY (the typed email) - reads only ever see the scenario. */
registerMockWriter('POST /api/auth/login', (body) =>
  loginAs(mockUserForEmail((body as { email: string }).email)),
)

/* Re-issues tokens for whoever is ALREADY signed in, read from the session
   rather than re-derived - a background refresh must never hand a different
   role to the tab that triggered it. requestUser() falls back to the MANAGER
   only for the case that should not happen outside a test: a refresh fired
   with no session behind it at all. */
registerMockWriter('POST /api/auth/refresh', () => ({
  ...loginAs(requestUser() ?? manager()),
  access_token: 'FIXTURE.ACCESS.TOKEN.REFRESHED',
  refresh_token: 'FIXTURE.REFRESH.TOKEN.REFRESHED',
}))

/* Same reasoning as refresh: reflects who is actually signed in. All three
   variants read the same session because "empty"/"large" describe list
   shapes elsewhere, not an identity to hand back here. */
registerMock<User>('GET /api/auth/me', {
  normal: () => requestUser() ?? manager(),
  empty: () => requestUser() ?? manager(),
  large: () => requestUser() ?? manager(),
})
