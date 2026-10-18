import { beforeEach, describe, expect, it } from 'vitest'
import * as store from './employeeStore'
import { ApiError } from '@/api/errors'

describe('the writable employee store', () => {
  beforeEach(store.resetEmployeeStore)

  it('makes a created employee visible to the next read', () => {
    const before = store.listEmployees().length
    const created = store.createEmployee({ first_name: 'Nour', last_name: 'Sabri' })

    expect(store.listEmployees()).toHaveLength(before + 1)
    expect(store.listEmployees()[0].id).toBe(created.id)
  })

  /* The backend derives is_active from status rather than accepting it, so a
     form that sent both could make them disagree. */
  it('derives is_active from status the way the backend does', () => {
    expect(store.createEmployee({ first_name: 'A', last_name: 'B' }).is_active).toBe(true)
    const onLeave = store.createEmployee({
      first_name: 'C',
      last_name: 'D',
      status: 'ON_LEAVE',
    })
    expect(onLeave.is_active).toBe(false)
  })

  /* Mirrors the 409 from the unique constraints on email and rfid_uid. A form
     that only meets this against a real server is a form nobody has tested. */
  it('rejects a duplicate RFID card', () => {
    store.createEmployee({ first_name: 'A', last_name: 'B', rfid_uid: 'RFID-999' })
    expect(() =>
      store.createEmployee({ first_name: 'C', last_name: 'D', rfid_uid: 'RFID-999' }),
    ).toThrow(ApiError)
  })

  it('lets an employee keep its own card when edited', () => {
    const created = store.createEmployee({
      first_name: 'A',
      last_name: 'B',
      rfid_uid: 'RFID-777',
    })
    const updated = store.updateEmployee(created.id, {
      rfid_uid: 'RFID-777',
      position: 'Caissier',
    })
    expect(updated.position).toBe('Caissier')
  })

  /* exclude_unset on the backend: an absent key is untouched, an explicit null
     clears the field. Those are different operations. */
  it('leaves absent fields alone and clears explicit nulls', () => {
    const created = store.createEmployee({
      first_name: 'A',
      last_name: 'B',
      position: 'Agent',
      phone: '0600000000',
    })

    const kept = store.updateEmployee(created.id, { first_name: 'Z' })
    expect(kept.position).toBe('Agent')
    expect(kept.phone).toBe('0600000000')

    const cleared = store.updateEmployee(created.id, { position: null })
    expect(cleared.position).toBeNull()
    expect(cleared.phone).toBe('0600000000')
  })

  it('removes a deleted employee and refuses an unknown id', () => {
    const created = store.createEmployee({ first_name: 'A', last_name: 'B' })
    store.deleteEmployee(created.id)
    expect(store.listEmployees().some((e) => e.id === created.id)).toBe(false)
    expect(() => store.deleteEmployee(created.id)).toThrow(ApiError)
  })
})
