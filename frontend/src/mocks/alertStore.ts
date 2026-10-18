import type { AlertStateFrame, StoredAlert } from '@/api/types'
import { CAMERA_ID_COUNTER, CAMERA_ID_LOBBY, CAMERA_ID_STORE } from './cameraStore'
import { AGENCY_ID, AGENCY_ID_RABAT } from './fixtures/people'

/**
 * Stored business alerts for mock mode - the rows behind
 * GET /api/agencies/{agency_id}/alerts.
 *
 * Seeded with a short past so the history panel has something in it on
 * first load, then kept in step with the scripted weapon feed: each
 * `alert_state` frame that feed sends is applied here too (aiStreams.ts), so
 * a refetch agrees with what the socket already said, as it would against the
 * backend.
 *
 * Weapon alerts are always CRITICAL and start OPEN, as
 * backend/app/ai_alerts/consumer.py creates them.
 */

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

let alerts: StoredAlert[] | null = null

function seed(): StoredAlert[] {
  if (alerts === null) {
    alerts = [
      {
        id: 'e1000000-0000-4000-8000-000000000001',
        agency_id: AGENCY_ID,
        camera_id: CAMERA_ID_COUNTER,
        camera_name: 'cam-counter',
        alert_type: 'weapon',
        severity: 'CRITICAL',
        status: 'RESOLVED',
        created_at: minutesAgo(95),
        resolved_at: minutesAgo(93),
      },
      {
        id: 'e1000000-0000-4000-8000-000000000002',
        agency_id: AGENCY_ID,
        camera_id: CAMERA_ID_LOBBY,
        camera_name: 'cam-lobby',
        alert_type: 'weapon',
        severity: 'CRITICAL',
        status: 'RESOLVED',
        created_at: minutesAgo(60 * 26),
        resolved_at: minutesAgo(60 * 26 - 4),
      },
      /* Raised by a camera that has since been deleted: the backend keeps the
         alert and nulls the camera, and the panel has to say so. */
      {
        id: 'e1000000-0000-4000-8000-000000000003',
        agency_id: AGENCY_ID,
        camera_id: null,
        camera_name: null,
        alert_type: 'weapon',
        severity: 'CRITICAL',
        status: 'RESOLVED',
        created_at: minutesAgo(60 * 50),
        resolved_at: minutesAgo(60 * 50 - 1),
      },
      {
        id: 'e1000000-0000-4000-8000-000000000004',
        agency_id: AGENCY_ID_RABAT,
        camera_id: CAMERA_ID_STORE,
        camera_name: 'cam-store',
        alert_type: 'weapon',
        severity: 'CRITICAL',
        status: 'RESOLVED',
        created_at: minutesAgo(60 * 5),
        resolved_at: minutesAgo(60 * 5 - 2),
      },
    ]
  }
  return alerts
}

export function listAlerts(agencyId: string, alertType: string | null): StoredAlert[] {
  return seed()
    .filter((a) => a.agency_id === agencyId && (alertType === null || a.alert_type === alertType))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((a) => ({ ...a }))
}

/** What the backend has committed by the time it sends the frame. */
export function applyAlertState(frame: AlertStateFrame): void {
  const list = seed()
  const row: StoredAlert = {
    id: frame.id,
    agency_id: frame.agency_id,
    camera_id: frame.camera_id,
    camera_name: frame.camera_name,
    alert_type: frame.alert_type,
    severity: frame.severity,
    status: frame.status,
    created_at: frame.created_at,
    resolved_at: frame.resolved_at,
  }
  const index = list.findIndex((a) => a.id === row.id)
  if (index === -1) list.push(row)
  else list[index] = row
}

/** Every branch's alerts, for actions that look an alert up by id. */
export function listAllForMock(): StoredAlert[] {
  return seed().map((a) => ({ ...a }))
}

/** A person acting on an alert (acknowledge, resolve, "It's staff"). */
export function updateAlert(id: string, patch: Partial<StoredAlert>): StoredAlert | null {
  const row = seed().find((a) => a.id === id)
  if (!row) return null
  Object.assign(row, patch)
  return { ...row }
}

/** Adds a stored alert (e.g. a scripted intrusion). */
export function addAlert(row: StoredAlert): void {
  seed().push(row)
}

/** For tests - the next read reseeds. */
export function resetAlertStore(): void {
  alerts = null
}
