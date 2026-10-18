import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Pins the login request body to what backend/app/schemas/auth.py declares.
 *
 * This test exists because contracts/api.md still documents only the response.
 * If someone "tidies" this to {username, password} - which is what the form
 * field used to be called - the server answers 422 and nothing else in the
 * codebase would have caught it.
 */
describe('login request body', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('sends exactly the fields LoginRequest declares', async () => {
    vi.stubEnv('VITE_USE_MOCKS', 'false')
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test')
    vi.resetModules()

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )

    const { login } = await import('./auth')
    await login({ email: 'leila@agency.com', password: 'secret123' })

    const init = fetchSpy.mock.calls[0][1]
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'leila@agency.com',
      password: 'secret123',
    })

    /* Login must never carry a token, even if one is somehow in the store. */
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})
