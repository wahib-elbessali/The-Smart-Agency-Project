import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every VITE_ variable is inlined into the client bundle in plain text. This
 * fails the build if someone adds one whose name reads like a credential.
 *
 * A name check, not a value check - it catches the mistake at the point it is
 * introduced, in review, rather than after a real secret has been committed.
 */
const SECRET_ISH = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/i

/* Resolved from the Vitest root (frontend/) rather than import.meta.url, which
   is not a file: URL under the jsdom environment. */
const envExample = path.resolve(process.cwd(), '.env.example')

describe('client bundle hygiene', () => {
  it('declares no secret-looking VITE_ variables in .env.example', () => {
    const offenders = readFileSync(envExample, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('VITE_'))
      .map((line) => line.split('=')[0] ?? '')
      .filter((name) => SECRET_ISH.test(name))

    expect(
      offenders,
      `These ship to every viewer in plain text and belong on the backend: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
