import { fetchJson } from '../client'
import type { Visitor, VisitorCreate } from '../types'

/**
 * Visitor endpoints — ADMIN, MANAGER, AGENT and SECURITY.
 *
 * Note that SECURITY appears here but NOT on the ticket routes below. A guard
 * can register someone at the door and then cannot issue them a ticket, which
 * looks like an oversight rather than a rule. Worth asking about; the frontend
 * does not paper over it.
 *
 * Agency scoping is the backend's job. A non-ADMIN's list is filtered to their
 * own agency and their creates are forced into it, so the frontend must not
 * filter again or it would hide rows an ADMIN is entitled to see.
 */

export function fetchVisitors(signal?: AbortSignal): Promise<Visitor[]> {
  return fetchJson<Visitor[]>(
    { key: 'GET /api/visitors', path: '/api/visitors', auth: true },
    { signal },
  )
}

/**
 * Registers someone who has walked in.
 *
 * `agency_id` is only read for an ADMIN - every other role has theirs
 * substituted server-side. An ADMIN who sends none gets 422 "agency_id est
 * obligatoire".
 */
export function createVisitor(body: VisitorCreate, signal?: AbortSignal): Promise<Visitor> {
  return fetchJson<Visitor>(
    { key: 'POST /api/visitors', path: '/api/visitors', method: 'POST', auth: true },
    { signal, body },
  )
}
