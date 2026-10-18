import { describe, expect, it } from 'vitest'
import { canReach } from './access'
import { landingPathFor } from './landing'
import { ROLES } from '@/api/types'

/**
 * The table itself, tested apart from any screen.
 *
 * It decides two things that must never disagree - what the navigation offers
 * and what a typed URL allows - so it is worth pinning on its own rather than
 * inferring it from whichever component happens to render.
 */
describe('canReach', () => {
  it('keeps user accounts to admins', () => {
    expect(canReach('ADMIN', '/users')).toBe(true)
    for (const role of ROLES.filter((r) => r !== 'ADMIN')) {
      expect(canReach(role, '/users')).toBe(false)
    }
  })

  it('gives agencies and employees to admins and managers only', () => {
    for (const path of ['/agencies', '/employees']) {
      expect(canReach('ADMIN', path)).toBe(true)
      expect(canReach('MANAGER', path)).toBe(true)
      expect(canReach('AGENT', path)).toBe(false)
      expect(canReach('SECURITY', path)).toBe(false)
      expect(canReach('TECHNICIAN', path)).toBe(false)
    }
  })

  /* Attendance is ADMIN, MANAGER and SECURITY - security staff read the roster
     even though they cannot administer the people on it. */
  it('includes security on presence', () => {
    expect(canReach('SECURITY', '/presence')).toBe(true)
    expect(canReach('AGENT', '/presence')).toBe(false)
  })

  /* No role-guarded endpoint behind these, so no role is kept out. */
  it('offers the unguarded screens to everyone', () => {
    for (const role of ROLES) {
      expect(canReach(role, '/climate')).toBe(true)
    }
  })

  /* The alert streams close anyone outside these roles with 1008. */
  it('keeps alerts to admins, managers and security', () => {
    for (const role of ['ADMIN', 'MANAGER', 'SECURITY'] as const) {
      expect(canReach(role, '/alerts')).toBe(true)
    }
    expect(canReach('TECHNICIAN', '/alerts')).toBe(false)
    expect(canReach('AGENT', '/alerts')).toBe(false)
  })

  /* Controls is ADMIN, MANAGER and SECURITY - same as cameras, transcribed
     from CONTROL_ROLES. */
  it('gives manual controls to admins, managers and security', () => {
    for (const role of ['ADMIN', 'MANAGER', 'SECURITY'] as const) {
      expect(canReach(role, '/controls')).toBe(true)
    }
    for (const role of ['AGENT', 'TECHNICIAN'] as const) {
      expect(canReach(role, '/controls')).toBe(false)
    }
  })

  /* Occupancy has no per-agency scoping behind it yet - every zone comes back
     regardless of role - so restricting who may look is the only lever this
     table has until the feed itself carries an agency_id. */
  it('gives occupancy to admins and managers only', () => {
    expect(canReach('ADMIN', '/occupancy')).toBe(true)
    expect(canReach('MANAGER', '/occupancy')).toBe(true)
    for (const role of ['AGENT', 'SECURITY', 'TECHNICIAN'] as const) {
      expect(canReach(role, '/occupancy')).toBe(false)
    }
  })

  /* Cameras and the weapon threshold are the guard's own tools - the one
     screen SECURITY can write to. Transcribed from CAMERA_ROLES; delete is
     narrower but that is hidden on the screen, not at the route. */
  it('gives cameras to admins, managers and security', () => {
    for (const role of ['ADMIN', 'MANAGER', 'SECURITY'] as const) {
      expect(canReach(role, '/cameras')).toBe(true)
    }
    expect(canReach('AGENT', '/cameras')).toBe(false)
    expect(canReach('TECHNICIAN', '/cameras')).toBe(false)
  })

  /* Zone drawing is narrower than the cameras screen it hangs off: a guard
     registers the cameras they watch, but the floor geometry every count is
     computed from is administration. PROPOSED, so this pins a product call
     rather than a transcription. */
  it('keeps zone drawing to admins and managers', () => {
    expect(canReach('ADMIN', '/zones')).toBe(true)
    expect(canReach('MANAGER', '/zones')).toBe(true)
    for (const role of ['SECURITY', 'AGENT', 'TECHNICIAN'] as const) {
      expect(canReach(role, '/zones')).toBe(false)
    }
  })

  /* Counter staffing reads the zones' statuses, so it cannot be wider than
     the zones themselves. */
  it('keeps counter staffing to admins and managers', () => {
    expect(canReach('ADMIN', '/staffing')).toBe(true)
    expect(canReach('MANAGER', '/staffing')).toBe(true)
    for (const role of ['SECURITY', 'AGENT', 'TECHNICIAN'] as const) {
      expect(canReach(role, '/staffing')).toBe(false)
    }
  })

  it('refuses everything to a session with no role', () => {
    expect(canReach(null, '/users')).toBe(false)
    expect(canReach(undefined, '/presence')).toBe(false)
  })

  /**
   * The one that would strand somebody.
   *
   * AppShell sends a role that cannot reach the current path to its landing
   * page. If that landing page were itself forbidden, the redirect would bounce
   * against the guard forever - so the two tables have to agree, and this is
   * the test that says so out loud.
   */
  it('gives every role a landing page it is allowed to reach', () => {
    for (const role of ROLES) {
      expect(canReach(role, landingPathFor(role))).toBe(true)
    }
  })
})
