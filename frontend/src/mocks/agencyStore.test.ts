import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import * as store from './agencyStore'

/**
 * The store stands in for the backend until there is one to talk to, so what
 * matters is that it refuses the same things with the same status codes. A mock
 * that accepts everything produces a form nobody has actually tested - the
 * first real 409 then arrives in front of a user.
 *
 * Each refusal asserted here is one contracts/api.md documents for
 * POST/PUT/DELETE /api/agencies.
 */

beforeEach(() => {
  store.resetAgencyStore()
})

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof ApiError ? error.status : undefined
  }
  return undefined
}

describe('createAgency', () => {
  it('applies the defaults the server applies rather than leaving them unset', () => {
    const created = store.createAgency({
      name: 'Agence Fes',
      zones: [{ name: 'Accueil' }],
      counters: [{ number: 1 }],
    })

    // is_active is derived: the create body has no such field.
    expect(created.is_active).toBe(true)
    expect(created.employees_count).toBe(0)
    expect(created.zones[0].zone_type).toBe('PUBLIC')
    expect(created.zones[0].is_private).toBe(false)
    expect(created.counters[0].is_open).toBe(true)
    expect(created.counters[0].name).toBeNull()
  })

  it('puts the new agency in the list', () => {
    store.createAgency({ name: 'Agence Fes' })
    expect(store.listAgencies().some((a) => a.name === 'Agence Fes')).toBe(true)
  })

  it('refuses two counters sharing a number with 409, not 422', () => {
    // The body is well formed; it is the pair that cannot exist.
    expect(
      statusOf(() =>
        store.createAgency({
          name: 'Agence Fes',
          counters: [{ number: 1 }, { number: 1 }],
        }),
      ),
    ).toBe(409)
  })

  it('allows distinct counter numbers', () => {
    const created = store.createAgency({
      name: 'Agence Fes',
      counters: [{ number: 1 }, { number: 2 }],
    })
    expect(created.counters).toHaveLength(2)
  })

  it('refuses a name shorter than two characters with 422', () => {
    expect(statusOf(() => store.createAgency({ name: 'A' }))).toBe(422)
  })

  it('refuses a name longer than 150 characters with 422', () => {
    expect(statusOf(() => store.createAgency({ name: 'x'.repeat(151) }))).toBe(422)
  })

  it('counts a whitespace-padded name by its trimmed length', () => {
    expect(statusOf(() => store.createAgency({ name: '  A  ' }))).toBe(422)
  })
})

describe('updateAgency', () => {
  it('leaves absent keys untouched, matching exclude_unset', () => {
    const [first] = store.listAgencies()
    const updated = store.updateAgency(first.id, { name: 'Renamed' })

    expect(updated.name).toBe('Renamed')
    expect(updated.address).toBe(first.address)
    expect(updated.opening_time).toBe(first.opening_time)
  })

  it('keeps zones and counters, which the update body cannot carry', () => {
    // The real risk this guards: PUT quietly emptying the counter list would
    // leave an agency whose tickets can never be called.
    const [first] = store.listAgencies()
    const updated = store.updateAgency(first.id, { name: 'Renamed' })

    expect(updated.counters).toHaveLength(first.counters.length)
    expect(updated.zones).toHaveLength(first.zones.length)
  })

  it('can deactivate without deleting', () => {
    const [first] = store.listAgencies()
    const updated = store.updateAgency(first.id, { is_active: false })

    expect(updated.is_active).toBe(false)
    expect(store.listAgencies()).toHaveLength(2)
  })

  it('validates the name only when one is sent', () => {
    const [first] = store.listAgencies()
    expect(statusOf(() => store.updateAgency(first.id, { name: 'A' }))).toBe(422)
    expect(statusOf(() => store.updateAgency(first.id, { phone: '0500' }))).toBeUndefined()
  })

  it('is a 404 for an unknown id', () => {
    expect(statusOf(() => store.updateAgency('nope', { name: 'Renamed' }))).toBe(404)
  })
})

describe('deleteAgency', () => {
  it('removes the agency', () => {
    const before = store.listAgencies()
    store.deleteAgency(before[0].id)

    const after = store.listAgencies()
    expect(after).toHaveLength(before.length - 1)
    expect(after.some((a) => a.id === before[0].id)).toBe(false)
  })

  it('is a 404 for an unknown id', () => {
    expect(statusOf(() => store.deleteAgency('nope'))).toBe(404)
  })
})

describe('getAgency', () => {
  it('returns a copy, so a caller cannot mutate the store by accident', () => {
    const [first] = store.listAgencies()
    const fetched = store.getAgency(first.id)
    fetched.name = 'Mutated'

    expect(store.getAgency(first.id).name).not.toBe('Mutated')
  })

  it('is a 404 for an unknown id', () => {
    expect(statusOf(() => store.getAgency('nope'))).toBe(404)
  })
})
