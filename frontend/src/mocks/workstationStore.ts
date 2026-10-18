import type { Workstation, WorkstationCreate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { listZones } from './zoneStore'

/**
 * A writable set of workstations for mock mode.
 *
 * The seeded three are the ones the mock status stream speaks about
 * (aiStreams.ts), bound to the three zones zoneStore seeds - the same chain
 * the real thing has: a camera carries a zone, a zone carries a workstation.
 * Unbind one here and the scripted stream keeps mentioning it, exactly as a
 * real stream would until its next snapshot; the screen only renders rows the
 * REST list still returns, which is what makes that harmless.
 *
 * Refusals mirror contracts/ai-service.md §/employee_activity:
 *   422  the named zone does not exist yet - the service's own refusal, and
 *        the reason the form picks from existing zones instead of free text
 *   422  a blank name
 *   404  deleting a workstation that does not exist
 *   Re-posting a name overwrites, as /zoning does. The service treats a
 *   workstation name as a key, not as a unique constraint to fight over.
 */

let workstations: Workstation[] | null = null

/* Fixed offsets from "now" at seed time, so a status that has been held for
   forty minutes still reads as forty minutes whenever the suite runs. */
function seed(): Workstation[] {
  if (workstations === null) {
    const now = Date.now() / 1000
    workstations = [
      /* Genuinely empty, and long enough that it is past the service's
         absence window - the state the screen exists to surface. Matches the
         mock stream's opening snapshot (aiStreams.ts), so the two agree the
         moment the socket connects. */
      { name: 'accueil', zone: 'lobby', status: 'away', since: now - 720, zone_known: true },
      {
        name: 'guichet-3',
        zone: 'counters',
        status: 'present',
        since: now - 2_400,
        zone_known: true,
      },
      /* Rabat, on a zone whose camera has never produced a frame. */
      { name: 'coffre', zone: 'vault', status: 'unknown', since: now - 7_200, zone_known: false },
    ]
  }
  return workstations
}

export function listWorkstations(): Workstation[] {
  return seed().map((station) => ({ ...station }))
}

export function createWorkstation(body: WorkstationCreate): Workstation {
  const name = body.name.trim()
  const zone = body.zone.trim()
  if (!name) throw new ApiError('http', 'Le nom du poste est obligatoire', 422)
  if (!listZones().some((existing) => existing.name === zone)) {
    throw new ApiError('http', `La zone "${zone}" n'existe pas`, 422)
  }

  const created: Workstation = {
    name,
    zone,
    /* Not `away`: nothing has been measured for this binding yet, and the
       difference between "no reading" and "empty" is the whole reason
       `zone_known` exists. The service classifies it on its next poll. */
    status: 'unknown',
    since: Date.now() / 1000,
    zone_known: false,
  }

  const list = seed()
  const existing = list.findIndex((station) => station.name === name)
  if (existing === -1) list.push(created)
  else list[existing] = created
  return { ...created }
}

export function deleteWorkstation(name: string): void {
  const list = seed()
  const index = list.findIndex((station) => station.name === name)
  if (index === -1) throw new ApiError('http', 'Poste introuvable', 404)
  list.splice(index, 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetWorkstationStore(): void {
  workstations = null
}
