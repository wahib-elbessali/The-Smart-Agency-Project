import { fetchJson } from '../client'
import type { TicketTemplate, TicketTemplateBlock } from '../types'

/**
 * The thermal-printer ticket layout, per agency. ADMIN and MANAGER (a manager
 * for their own agency only). PUT replaces the whole template; the kiosk picks
 * the change up within a minute.
 */

export function fetchTicketTemplate(
  agencyId: string,
  signal?: AbortSignal,
): Promise<TicketTemplate> {
  return fetchJson<TicketTemplate>(
    {
      key: 'GET /api/agencies/{id}/ticket-template',
      path: `/api/agencies/${agencyId}/ticket-template`,
      auth: true,
    },
    { signal },
  )
}

export function saveTicketTemplate(
  agencyId: string,
  template: TicketTemplateBlock[],
  signal?: AbortSignal,
): Promise<TicketTemplate> {
  return fetchJson<TicketTemplate>(
    {
      key: 'PUT /api/agencies/{id}/ticket-template',
      path: `/api/agencies/${agencyId}/ticket-template`,
      method: 'PUT',
      auth: true,
    },
    { signal, body: { template } },
  )
}
