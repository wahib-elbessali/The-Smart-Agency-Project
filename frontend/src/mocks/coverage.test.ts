import { describe, expect, it } from 'vitest'
import { hasMockFor } from './registry'
import '@/mocks'

/* Mock mode is the default for a new setup (.env.example), and the 2026-10-18
   review found 34 endpoints added since that had no fixture, so their screens
   only said "No fixture registered" there. Every endpoint the app calls must
   be answerable in mock mode. */
const sources = import.meta.glob('../api/endpoints/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('mock coverage', () => {
  it('has a fixture or a writer for every endpoint the app calls', () => {
    const keys = new Set<string>()
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/key: '((?:GET|POST|PUT|PATCH|DELETE) [^']+)'/g)) {
        keys.add(match[1])
      }
    }
    expect(keys.size).toBeGreaterThan(100)
    expect([...keys].filter((key) => !hasMockFor(key)).sort()).toEqual([])
  })
})
