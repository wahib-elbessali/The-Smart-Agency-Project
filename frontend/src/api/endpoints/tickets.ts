import { fetchJson } from '../client'
import { ApiError, describeApiError } from '../errors'
import type { Ticket, TicketCreate, TrackedTicket, VisitorHistory } from '../types'

/**
 * Ticket endpoints — ADMIN, MANAGER and AGENT only, except `fetchTrackedTickets`
 * (ADMIN, MANAGER, SECURITY - same roles as /tracking, a monitoring read for
 * the live map rather than a ticket-handling action). SECURITY is otherwise
 * deliberately absent here even though it may create visitors.
 *
 * The state machine the backend enforces:
 *
 *   WAITING --call--> CALLED --start-service--> IN_SERVICE --complete--> COMPLETED
 *      |                 |                                     |
 *      |                 +---------------skip (no-show)--------+--> NO_SHOW
 *      +------cancel-----+----------------------------------------> CANCELLED
 *
 * `complete` also accepts CALLED directly (start-service is optional, not a
 * gate) - see AgentQueue.tsx. `start-service`/`skip` are always manual,
 * agent-pressed actions, never automatic or tracking-triggered.
 *
 * Each refusal is a 409 rather than a 422, because the request is well formed -
 * it is the ticket's current state that makes it impossible.
 */

/**
 * The waiting queue - and ONLY the waiting queue.
 *
 * This is the significant limitation of the whole screen. The endpoint filters
 * to `status == WAITING`, so the moment a ticket is called it disappears from
 * the only list route that exists. There is no way to ask the server which
 * tickets are currently at a counter, which means "now serving" cannot survive
 * a page reload - the screen has to remember it, and forgets on refresh.
 *
 * Ordered oldest first, which is the order they should be called in.
 *
 * `serviceId` narrows to one service's queue, added alongside `service_id` on
 * TicketCreate (2026-08-27). Omit it for the whole agency's queue.
 */
export function fetchQueue(serviceId?: string, signal?: AbortSignal): Promise<Ticket[]> {
  const path = serviceId
    ? `/api/tickets/queue?service_id=${encodeURIComponent(serviceId)}`
    : '/api/tickets/queue'
  return fetchJson<Ticket[]>({ key: 'GET /api/tickets/queue', path, auth: true }, { signal })
}

/**
 * Every non-terminal ticket currently linked to a live tracked person - the
 * kiosk-zone correlation. Used by
 * Tracking.tsx to relabel a tracked dot by ticket number instead of a bare
 * AI track id. Most tickets will never appear here at all: linking only
 * happens for kiosk-created tickets, only when the agency has a kiosk zone
 * configured, and only if someone was actually standing in it.
 */
export function fetchTrackedTickets(signal?: AbortSignal): Promise<TrackedTicket[]> {
  return fetchJson<TrackedTicket[]>(
    { key: 'GET /api/tickets/tracked', path: '/api/tickets/tracked', auth: true },
    { signal },
  )
}

/**
 * Issues a ticket to a visitor who already exists, for a service that must
 * belong to the same agency as the visitor.
 *
 * The number is assigned server-side as "YYYYMMDD-SERVICE_CODE-001", counted
 * per agency, per service and restarting daily - so it is never sent and
 * never guessed here.
 */
export function createTicket(body: TicketCreate, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    { key: 'POST /api/tickets', path: '/api/tickets', method: 'POST', auth: true },
    { signal, body },
  )
}

/**
 * Calls a waiting ticket to a counter.
 *
 * Four ways this refuses, all of them reachable by a person clicking normally:
 * the ticket is no longer WAITING (409), the counter does not exist (404), the
 * counter belongs to another agency (422), or the counter is closed (409).
 * Counters come from the nested `counters` on GET /api/agencies.
 */
export function callTicket(id: string, counterId: string, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    {
      key: 'POST /api/tickets/{id}/call',
      path: `/api/tickets/${id}/call`,
      method: 'POST',
      auth: true,
    },
    { signal, body: { counter_id: counterId } },
  )
}

/**
 * Only valid from CALLED or IN_SERVICE; anything else is a 409.
 *
 * `notes` is optional. Omitting it sends no body, which remains supported for
 * clients that do not record a completion note.
 */
export function completeTicket(id: string, notes?: string, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    {
      key: 'POST /api/tickets/{id}/complete',
      path: `/api/tickets/${id}/complete`,
      method: 'POST',
      auth: true,
    },
    { signal, body: notes === undefined ? undefined : { notes } },
  )
}

/**
 * Marks the moment the visitor actually arrived at the counter. Only valid
 * from CALLED; anything else is a 409. Sets `in_service_at`, which is what
 * lets walk-over time and service duration be told apart - see
 * WaitTimeInsights.
 */
export function startService(id: string, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    {
      key: 'POST /api/tickets/{id}/start-service',
      path: `/api/tickets/${id}/start-service`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

/**
 * The no-show button. Only valid from CALLED, and only once the agency's
 * `no_show_min_wait_seconds` has elapsed since `called_at` - enforced here
 * server-side as a backstop; AgentQueue.tsx disables the button itself
 * before ever calling this, which is the real gate.
 */
export function skipTicket(id: string, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    {
      key: 'POST /api/tickets/{id}/skip',
      path: `/api/tickets/${id}/skip`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

/** Valid from any state except COMPLETED and CANCELLED, which give a 409. */
export function cancelTicket(id: string, signal?: AbortSignal): Promise<Ticket> {
  return fetchJson<Ticket>(
    {
      key: 'POST /api/tickets/{id}/cancel',
      path: `/api/tickets/${id}/cancel`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

/**
 * Turns a ticket-action failure into what a screen shows a person.
 *
 * Shared by VisitorQueueBoard and AgentQueue - both act on the routes above
 * and hit the same shapes of refusal (ticket moved under you, counter
 * gone/wrong agency/closed, or - for skip specifically - the no-show wait
 * hasn't elapsed yet, also a 409).
 */
export function actionErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'That did not work.'

  switch (error.status) {
    /* Every 409 here means the ticket moved under you - most likely a colleague
       called the same person from another desk. Refetching is the fix, and the
       queue does it automatically after every action. */
    case 409:
      return 'That ticket has already been handled, or the counter is closed. The queue has been refreshed.'
    case 404:
      return 'That ticket or counter no longer exists.'
    case 422:
      return 'That counter cannot take this ticket — wrong branch or wrong service. The queue has been refreshed.'
    default:
      return describeApiError(error)
  }
}

/** Earlier visits of the same person, matched by the face captured at the kiosk. */
export function fetchVisitorHistory(id: string, signal?: AbortSignal): Promise<VisitorHistory> {
  return fetchJson<VisitorHistory>(
    { key: 'GET /api/tickets/{id}/history', path: `/api/tickets/${id}/history`, auth: true },
    { signal },
  )
}
