import { fetchJson } from '../client'
import type { DeviceCommand, ManualControlRequest, ManualControlResult } from '../types'

/**
 * Manual hardware override endpoint - contracts/api.md, added 2026-09-23.
 * ADMIN, MANAGER and SECURITY.
 *
 * Blocks up to the backend's manual_control_ack_timeout_seconds (default
 * 10s) - see app/mqtt/manual_control.py's header on the backend for why a
 * single blocking call, not polling. Never rejects on a device timeout or a
 * device-reported failure; those are real answers in the response body
 * ("unknown" / "failed"), not request errors. Only a network/auth failure
 * throws.
 */
export function sendControlCommand(
  deviceId: string,
  body: ManualControlRequest,
  signal?: AbortSignal,
): Promise<ManualControlResult> {
  return fetchJson<ManualControlResult>(
    {
      key: 'POST /api/controls/devices/{id}/command',
      path: `/api/controls/devices/${deviceId}/command`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

/** Device type -> the commands a device of that type accepts, with their
 * button labels - contracts/device-commands.json, through the backend. */
export function fetchControlCommands(
  signal?: AbortSignal,
): Promise<Record<string, DeviceCommand[]>> {
  return fetchJson<Record<string, DeviceCommand[]>>(
    { key: 'GET /api/controls/commands', path: '/api/controls/commands', auth: true },
    { signal },
  )
}
