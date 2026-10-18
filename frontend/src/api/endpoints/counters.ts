import { fetchJson } from '../client'
import type { Counter, CounterCreate, CounterUpdate } from '../types'

/**
 * Counter (guichet/bureau) management - backend/app/api/counters.py, added
 * 2026-09-23.
 *
 * Before this, a Counter was writable exactly once: inside POST /agencies,
 * at the moment a branch was first created. There was no route to add a
 * 5th window, rename one, or close it afterward - a branch that wanted to
 * open a new counter could not, through this app or its API. This is the
 * rest of the CRUD that was missing.
 *
 * Which service a counter serves is a separate route this file does not
 * duplicate - see api/endpoints/services.ts's assignCounterService, already
 * wired into the Services screen.
 *
 * Roles: ADMIN, MANAGER, AGENT read; ADMIN, MANAGER write - same split as
 * services themselves.
 */

export function fetchCounters(agencyId: string, signal?: AbortSignal): Promise<Counter[]> {
  return fetchJson<Counter[]>(
    {
      key: 'GET /api/agencies/{id}/counters',
      path: `/api/agencies/${agencyId}/counters`,
      auth: true,
    },
    { signal },
  )
}

export function createCounter(
  agencyId: string,
  body: CounterCreate,
  signal?: AbortSignal,
): Promise<Counter> {
  return fetchJson<Counter>(
    {
      key: 'POST /api/agencies/{id}/counters',
      path: `/api/agencies/${agencyId}/counters`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

export function updateCounter(
  counterId: string,
  body: CounterUpdate,
  signal?: AbortSignal,
): Promise<Counter> {
  return fetchJson<Counter>(
    {
      key: 'PUT /api/counters/{id}',
      path: `/api/counters/${counterId}`,
      method: 'PUT',
      auth: true,
    },
    { signal, body },
  )
}

/** 409 when an agent is still assigned to this counter. */
export function deleteCounter(counterId: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/counters/{id}',
      path: `/api/counters/${counterId}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
