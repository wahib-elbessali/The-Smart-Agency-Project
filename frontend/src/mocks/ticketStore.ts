import type { Counter, Ticket, TicketCreate, Visitor, VisitorCreate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { getAgency } from './agencyStore'
import { AGENCY_ID } from './fixtures/people'
import { getService, SERVICE_ID_OUV, SERVICE_ID_VIR } from './serviceStore'

/**
 * A writable visitor and ticket store for mock mode.
 *
 * The queue is the one screen in this dashboard that is a state machine rather
 * than a list, so the fixtures have to enforce the transitions or the screen
 * gets built against rules that do not exist. Every refusal below mirrors
 * backend/app/api/tickets.py, with the same status code and the same French
 * `detail` string.
 *
 * The most important behaviour to reproduce is the awkward one: the real
 * `/tickets/queue` returns ONLY waiting tickets. A called ticket vanishes from
 * it. If the mock returned everything, the screen would be built against a
 * queue that does not exist and would break the first time it met the real
 * backend.
 */

/* Counters belong to an agency and can be closed. Two open, one shut, so the
   "counter is closed" refusal is reachable by clicking rather than only in a
   unit test.
 *
 * Counter 1 is assigned to VIR (a COUNTER-type service), matching the point
 * type both share. Counter 2 is unassigned, so "call to any open counter" and
 * "call to the counter assigned to this ticket's service" both stay reachable.
 * Counter 3 covers OUV (an OFFICE-type service) as well as being the closed
 * one - a ticket for an office-type service being called there is the only
 * way to see counter/service point_type mismatches on a matching pair. */
export const COUNTERS: Counter[] = [
  {
    id: 'c1000000-0000-4000-8000-000000000001',
    number: 1,
    name: 'Guichet 1',
    point_type: 'COUNTER',
    is_open: true,
    service_id: SERVICE_ID_VIR,
    emotion_camera_id: null,
    workstation_name: null,
  },
  {
    id: 'c1000000-0000-4000-8000-000000000002',
    number: 2,
    name: 'Guichet 2',
    point_type: 'COUNTER',
    is_open: true,
    service_id: null,
    emotion_camera_id: null,
    workstation_name: null,
  },
  {
    id: 'c1000000-0000-4000-8000-000000000003',
    number: 3,
    name: 'Guichet 3',
    point_type: 'OFFICE',
    is_open: false,
    service_id: SERVICE_ID_OUV,
    emotion_camera_id: null,
    workstation_name: null,
  },
]

const SEED_VISITORS: Array<[string, string | null, string | null]> = [
  ['Rachid El Fassi', '0661234567', 'CIN AB123456'],
  ['Salma Bennani', '0662345678', null],
  ['Youssef Amrani', null, 'CIN CD789012'],
  ['Khadija Moussaoui', '0664567890', null],
]

let visitors: Visitor[] | null = null
let tickets: Ticket[] | null = null
let counter = 0

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

function seed(): { visitors: Visitor[]; tickets: Ticket[] } {
  if (visitors === null || tickets === null) {
    visitors = SEED_VISITORS.map(([full_name, phone, identity_reference], i) => ({
      id: `v1000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      agency_id: AGENCY_ID,
      full_name,
      phone,
      identity_reference,
      created_at: iso(40 - i * 8),
    }))

    /* Four waiting, oldest first - enough to show ordering matters, and to see
       the queue shorten as they are called. One references no service at all:
       service_id/service_code/service_name are nullable on a real ticket
       (predates the Services contract, or its service was later deleted), and
       a row that never populates them would hide that from the screen. */
    const seeds: Array<{ serviceId: string | null; freeText: string | null }> = [
      { serviceId: SERVICE_ID_VIR, freeText: null },
      { serviceId: SERVICE_ID_OUV, freeText: null },
      { serviceId: null, freeText: null },
      { serviceId: SERVICE_ID_VIR, freeText: 'Conseil' },
    ]
    const built: Ticket[] = []
    for (const [i, visitor] of visitors.entries()) {
      const { serviceId, freeText } = seeds[i]
      const service = serviceId ? getService(serviceId) : null
      built.push({
        id: `t1000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        visitor_id: visitor.id,
        visitor_name: visitor.full_name,
        agency_id: visitor.agency_id,
        service_id: service?.id ?? null,
        service_code: service?.code ?? null,
        service_name: service?.name ?? null,
        counter_id: null,
        ticket_number: nextTicketNumber(built, visitor.agency_id, service),
        service_type: freeText ?? service?.name ?? null,
        status: 'WAITING' as const,
        created_at: visitor.created_at,
        called_at: null,
        in_service_at: null,
        completed_at: null,
        notes: null,
        tracking_id: null,
      })
    }
    tickets = built
    counter = tickets.length
  }
  return { visitors, tickets }
}

/**
 * Same shape ticket_service.py builds: "YYYYMMDD-CODE-NNN", counting only
 * tickets that share the agency, the service code and today's date - so two
 * services in the same agency each start their own sequence at 001, and a
 * ticket with no service falls under the "GEN" bucket rather than colliding
 * with a real code.
 */
function nextTicketNumber(
  existing: Ticket[],
  agencyId: string,
  service: { code: string } | null,
): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const code = service?.code ?? 'GEN'
  const prefix = `${stamp}-${code}-`
  const count = existing.filter(
    (t) => t.agency_id === agencyId && t.ticket_number.startsWith(prefix),
  ).length
  return `${prefix}${String(count + 1).padStart(3, '0')}`
}

export function listVisitors(): Visitor[] {
  return [...seed().visitors]
}

export function createVisitor(body: VisitorCreate): Visitor {
  const created: Visitor = {
    id: `v9000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    /* A non-ADMIN's agency is substituted server-side, so whatever arrives here
       is either the admin's choice or irrelevant. */
    agency_id: body.agency_id ?? AGENCY_ID,
    full_name: body.full_name.trim(),
    phone: body.phone ?? null,
    identity_reference: body.identity_reference ?? null,
    created_at: new Date().toISOString(),
  }
  seed().visitors.unshift(created)
  return created
}

export function createTicket(body: TicketCreate): Ticket {
  const { visitors: vs, tickets: ts } = seed()
  const visitor = vs.find((v) => v.id === body.visitor_id)
  if (!visitor) throw new ApiError('http', 'Visiteur introuvable', 404)

  const service = getService(body.service_id)
  if (service.agency_id !== visitor.agency_id) {
    throw new ApiError('http', 'Le service appartient a une autre agence', 422)
  }
  if (!service.is_active) throw new ApiError('http', 'Le service est inactif', 409)

  const created: Ticket = {
    id: `t9000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    visitor_id: visitor.id,
    visitor_name: visitor.full_name,
    agency_id: visitor.agency_id,
    service_id: service.id,
    service_code: service.code,
    service_name: service.name,
    counter_id: null,
    ticket_number: nextTicketNumber(ts, visitor.agency_id, service),
    service_type: body.service_type ?? service.name,
    status: 'WAITING',
    created_at: new Date().toISOString(),
    called_at: null,
    in_service_at: null,
    completed_at: null,
    notes: null,
    tracking_id: null,
  }
  ts.push(created)
  return created
}

/**
 * WAITING only, oldest first - exactly what the real endpoint does.
 *
 * Returning called tickets here would be more convenient and would teach the
 * screen a guarantee the backend does not make.
 *
 * `serviceId` mirrors the real `?service_id=` filter (contracts/api.md §8).
 */
export function listQueue(serviceId?: string | null): Ticket[] {
  return seed()
    .tickets.filter((t) => t.status === 'WAITING' && (!serviceId || t.service_id === serviceId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function find(id: string): Ticket {
  const ticket = seed().tickets.find((t) => t.id === id)
  if (!ticket) throw new ApiError('http', 'Ticket introuvable', 404)
  return ticket
}

export function callTicket(id: string, counterId: string): Ticket {
  const ticket = find(id)
  /* 409, not 422: the request is well formed, the ticket's state is the
     problem. Two people calling the same person is the obvious way to hit it. */
  if (ticket.status !== 'WAITING') {
    throw new ApiError('http', 'Ce ticket n est plus en attente', 409)
  }

  const found = COUNTERS.find((c) => c.id === counterId)
  if (!found) throw new ApiError('http', 'Guichet introuvable', 404)
  if (!found.is_open) throw new ApiError('http', 'Le guichet est ferme', 409)
  /* Both checks from tickets.py's call_ticket, in the same order: the counter
     must be assigned to this ticket's service (when it has one), and its
     point_type must match the service's - a ticket for an OFFICE-type service
     cannot be called to a plain COUNTER even if nobody has assigned it yet. */
  if (ticket.service_id !== null && found.service_id !== ticket.service_id) {
    throw new ApiError('http', 'Le guichet n est pas affecte au service du ticket', 422)
  }
  if (ticket.service_id !== null) {
    const service = getService(ticket.service_id)
    if (found.point_type !== service.point_type) {
      throw new ApiError('http', 'Le type de point ne correspond pas au service du ticket', 422)
    }
  }

  ticket.counter_id = found.id
  ticket.status = 'CALLED'
  ticket.called_at = new Date().toISOString()
  return { ...ticket }
}

/** GET /api/services/{id}/points, filtered to this agency's counters. */
export function listServicePoints(serviceId: string): Counter[] {
  return COUNTERS.filter((c) => c.service_id === serviceId).map((c) => ({ ...c }))
}

export function assignCounterService(counterId: string, serviceId: string | null): Counter {
  const found = COUNTERS.find((c) => c.id === counterId)
  if (!found) throw new ApiError('http', 'Guichet ou bureau introuvable', 404)

  if (serviceId === null) {
    found.service_id = null
    found.point_type = 'COUNTER'
  } else {
    const service = getService(serviceId)
    if (!service.is_active) {
      throw new ApiError('http', 'Impossible d affecter un point a un service inactif', 409)
    }
    found.service_id = service.id
    found.point_type = service.point_type
  }
  return { ...found }
}

/** Manual, agent-pressed - mirrors tickets.py's start-service route. */
export function startService(id: string): Ticket {
  const ticket = find(id)
  if (ticket.status !== 'CALLED') {
    throw new ApiError('http', 'Ce ticket n est pas en cours d appel', 409)
  }
  ticket.status = 'IN_SERVICE'
  ticket.in_service_at = new Date().toISOString()
  return { ...ticket }
}

/** Manual, agent-pressed, gated by the agency's no_show_min_wait_seconds -
 * mirrors tickets.py's skip route, including its 409 message shape. */
export function skipTicket(id: string): Ticket {
  const ticket = find(id)
  if (ticket.status !== 'CALLED') {
    throw new ApiError('http', 'Ce ticket n est pas en cours d appel', 409)
  }
  const minWait = getAgency(ticket.agency_id).no_show_min_wait_seconds
  const elapsed = ticket.called_at ? (Date.now() - new Date(ticket.called_at).getTime()) / 1000 : 0
  if (elapsed < minWait) {
    throw new ApiError(
      'http',
      `Attendre encore ${Math.ceil(minWait - elapsed)}s avant de marquer ce ticket absent`,
      409,
    )
  }
  ticket.status = 'NO_SHOW'
  return { ...ticket }
}

/** `notes` is real now - backend/app/api/tickets.py's complete route takes
 * it as an optional body field, contracts/api.md already documents it. */
export function completeTicket(id: string, notes?: string | null): Ticket {
  const ticket = find(id)
  if (ticket.status !== 'CALLED' && ticket.status !== 'IN_SERVICE') {
    throw new ApiError('http', 'Ce ticket ne peut pas etre termine', 409)
  }
  ticket.status = 'COMPLETED'
  ticket.completed_at = new Date().toISOString()
  if (notes) ticket.notes = notes
  return { ...ticket }
}

export function cancelTicket(id: string): Ticket {
  const ticket = find(id)
  if (ticket.status === 'COMPLETED' || ticket.status === 'CANCELLED') {
    throw new ApiError('http', 'Ce ticket est deja termine ou annule', 409)
  }
  ticket.status = 'CANCELLED'
  return { ...ticket }
}

/** Tests only - module state would otherwise leak between them. */
export function resetTicketStore(): void {
  visitors = null
  tickets = null
  counter = 0
}
