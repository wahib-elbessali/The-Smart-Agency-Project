import { registerMock, registerMockWriter } from '../registry'
import type { Ticket, TicketCreate, TrackedTicket, Visitor, VisitorCreate } from '@/api/types'
import * as store from '../ticketStore'

/**
 * Field names from VisitorResponse and TicketResponse in
 * backend/app/schemas/. Both were added by PR #67 and are now on master.
 *
 * `normal` reads through the writable store, because this screen is almost
 * entirely writes - a frozen queue that never shortens when you call someone
 * would be useless for building against.
 */

registerMock<Visitor[]>('GET /api/visitors', {
  normal: () => store.listVisitors(),
  empty: () => [],
  large: () => store.listVisitors(),
})

/** `?service_id=` narrows the queue - see fetchQueue in endpoints/tickets.ts. */
function serviceIdFrom(path: string): string | undefined {
  const query = path.split('?')[1]
  return query ? (new URLSearchParams(query).get('service_id') ?? undefined) : undefined
}

registerMock<Ticket[]>('GET /api/tickets/queue', {
  normal: (path) => store.listQueue(serviceIdFrom(path)),
  /* An empty queue is the normal state of a quiet branch, not a failure, and
     the screen has to say so warmly rather than looking broken. */
  empty: () => [],
  large: (path) => store.listQueue(serviceIdFrom(path)),
})

registerMockWriter('POST /api/visitors', (body) => store.createVisitor(body as VisitorCreate))
registerMockWriter('POST /api/tickets', (body) => store.createTicket(body as TicketCreate))

/** The id sits in the path, and the action is the segment after it. */
function idFrom(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 2] ?? ''
}

registerMockWriter('POST /api/tickets/{id}/call', (body, path) =>
  store.callTicket(idFrom(path), (body as { counter_id: string }).counter_id),
)

registerMockWriter('POST /api/tickets/{id}/complete', (body, path) =>
  store.completeTicket(idFrom(path), (body as { notes?: string } | undefined)?.notes),
)

registerMockWriter('POST /api/tickets/{id}/cancel', (_body, path) =>
  store.cancelTicket(idFrom(path)),
)

registerMockWriter('POST /api/tickets/{id}/start-service', (_body, path) =>
  store.startService(idFrom(path)),
)

registerMockWriter('POST /api/tickets/{id}/skip', (_body, path) => store.skipTicket(idFrom(path)))

/* Kiosk-zone tracking link (scenario-planning backlog, Phase B) is entirely
 * backend/AI-driven - the mock store has no notion of live tracked people,
 * so there's never anything to report here. Always empty is the honest
 * fixture, not a stand-in for one that's missing. */
registerMock<TrackedTicket[]>('GET /api/tickets/tracked', {
  normal: () => [],
  empty: () => [],
  large: () => [],
})
