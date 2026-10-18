import { fetchJson } from '../client'
import type { Announcement, AnnouncementCreate } from '../types'

/**
 * Broadcast messages to employees - contracts/api.md, added 2026-09-23.
 *
 * Reading is every signed-in role, no route to narrow it - an announcement
 * is FOR employees. Posting and deleting are ADMIN and MANAGER only, and a
 * site-wide one (no agency_id) is ADMIN only, enforced backend-side.
 */

export function fetchAnnouncements(signal?: AbortSignal): Promise<Announcement[]> {
  return fetchJson<Announcement[]>(
    { key: 'GET /api/announcements', path: '/api/announcements', auth: true },
    { signal },
  )
}

export function createAnnouncement(
  body: AnnouncementCreate,
  signal?: AbortSignal,
): Promise<Announcement> {
  return fetchJson<Announcement>(
    { key: 'POST /api/announcements', path: '/api/announcements', method: 'POST', auth: true },
    { signal, body },
  )
}

export function deleteAnnouncement(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/announcements/{id}',
      path: `/api/announcements/${id}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
