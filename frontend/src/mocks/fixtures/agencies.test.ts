import { afterEach, describe, expect, it } from 'vitest'
import { resolveMock } from '../registry'
import { resetAgencyStore } from '../agencyStore'
import { mockAdmin, mockManager } from '../currentUser'
import { AGENCY_ID_RABAT } from './people'
import { clearSession, setSession } from '@/api/tokenStore'
import type { Agency, User } from '@/api/types'
import './agencies'

/**
 * A MANAGER sees one branch: their own.
 *
 * Tested at the fixture rather than through a screen because the screen is not
 * where the rule lives, and must not be - a MANAGER's list arrives already
 * filtered from the backend and filtering it again in a component would take
 * rows away from an ADMIN who is entitled to them. This layer stands in for the
 * backend, so this is where the filter belongs and where it is worth pinning.
 *
 * It was missing here for long enough to be reported from testing: on fixtures
 * a manager saw both branches, including an Edit button that PUT /api/agencies
 * answers with 403 "Acces limite a votre agence".
 */
function signInAs(user: User) {
  setSession({ accessToken: 'T', refreshToken: 'R', user })
}

/* Awaited because a fixture is allowed to be async now - the camera frame
   decodes a video when one is present (mocks/videoFrames.ts). This one is
   synchronous and awaiting a plain value costs nothing. */
const list = async () => await resolveMock<Agency[]>('GET /api/agencies', 'normal')

describe('GET /api/agencies fixture', () => {
  afterEach(() => {
    clearSession()
    resetAgencyStore()
  })

  it('gives an admin every branch', async () => {
    signInAs(mockAdmin())
    expect((await list()).map((a: Agency) => a.name)).toEqual(['Agence Casablanca', 'Agence Rabat'])
  })

  it('gives a manager only their own', async () => {
    signInAs(mockManager())
    expect((await list()).map((a: Agency) => a.name)).toEqual(['Agence Casablanca'])
  })

  it('scopes to the agency on the account, not to a fixed one', async () => {
    signInAs({ ...mockManager(), agency_id: AGENCY_ID_RABAT })
    /* A manager moved to another branch follows their account - the filter
       reads agency_id and nothing else. */
    expect((await list()).map((a: Agency) => a.name)).toEqual(['Agence Rabat'])
  })

  /* Unscoped rather than empty: a request with no session is a 401 against the
     real API, not a filtered list, so there is nothing truthful to scope to. */
  it('does not scope when nobody is signed in', async () => {
    expect(await list()).toHaveLength(2)
  })
})
