import { beforeEach, describe, expect, it } from 'vitest'
import { registerMock, resolveMock } from './registry'
import { ApiError } from '@/api/errors'

describe('mock registry', () => {
  beforeEach(() => {
    registerMock<{ rows: number[] }>('/test/key', {
      normal: () => ({ rows: [1, 2, 3] }),
      empty: () => ({ rows: [] }),
      large: () => ({ rows: Array.from({ length: 200 }, (_, i) => i) }),
    })
  })

  it('serves the requested scenario', async () => {
    expect((await resolveMock<{ rows: number[] }>('/test/key', 'normal')).rows).toHaveLength(3)
    expect((await resolveMock<{ rows: number[] }>('/test/key', 'empty')).rows).toHaveLength(0)
    expect((await resolveMock<{ rows: number[] }>('/test/key', 'large')).rows).toHaveLength(200)
  })

  it('falls back to a simulated 500 when an endpoint has no error fixture', () => {
    expect(() => resolveMock('/test/key', 'error')).toThrowError(
      expect.objectContaining({ kind: 'http', status: 500 }),
    )
  })

  /* The important one: an unregistered key must fail loudly and say what to do,
     rather than returning undefined and letting a screen render blank. */
  it('names the missing fixture and points at the contract', () => {
    let thrown: unknown
    try {
      resolveMock('/not/registered', 'normal')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).kind).toBe('not_implemented')
    expect((thrown as ApiError).message).toContain('/not/registered')
    expect((thrown as ApiError).message).toContain('contracts/api.md')
  })
})
