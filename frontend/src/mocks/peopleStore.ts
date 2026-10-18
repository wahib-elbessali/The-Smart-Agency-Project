import type { PeoplePhase, PeopleSources, PeopleStatus, TrackDict } from '@/api/types'
import { listCalibration } from './calibrationStore'

/**
 * Mock state for /people (ai/features/person_tracking/api.py), shared by
 * two callers: zoneStore's world-zone warning (a world zone counts against
 * /people's live tracks, and reads 0 until it's running) and the live-map
 * screen itself. One store, not two, so both agree on the same phase.
 *
 * BOOTSTRAP IS AUTOMATIC, NOT A MOCK SHORTCUT.
 *
 * The real service has no POST /people/start - it bootstraps on its own
 * once >=2 registered cameras are calibrated AND aligned, and GET
 * /people/status is the only observability an explicit start endpoint would
 * have given anyway. This store reproduces that: phase is DERIVED from the
 * calibration store's current state every time it's read, never set
 * directly by a caller.
 */

let sourcesKnown: string[] | null = null
/* Bootstrapping is a real, observable delay in the reference service (~30s
   on a live source) - reproduced here as a few ticks of the phase reading
   'bootstrapping' before settling on 'running', keyed off when the 2nd
   ready camera was registered, not a fixed timer nobody can watch happen. */
let bootstrapStartedAt: number | null = null
const BOOTSTRAP_MS = 3_000

function sources(): string[] {
  if (sourcesKnown === null) sourcesKnown = []
  return sourcesKnown
}

function readiness(): { known: string[]; calibratedSet: Set<string>; alignedSet: Set<string> } {
  const cal = listCalibration()
  return {
    known: sources(),
    calibratedSet: new Set(cal.map((c) => c.camera_id)),
    alignedSet: new Set(cal.filter((c) => c.aligned).map((c) => c.camera_id)),
  }
}

function currentPhase(): PeoplePhase {
  const { known, alignedSet } = readiness()
  const ready = known.length >= 2 && known.every((id) => alignedSet.has(id))
  if (!ready) {
    bootstrapStartedAt = null
    return 'idle'
  }
  if (bootstrapStartedAt === null) bootstrapStartedAt = Date.now()
  return Date.now() - bootstrapStartedAt < BOOTSTRAP_MS ? 'bootstrapping' : 'running'
}

/** Merges into the registry, same "accumulates across calls" convention as
 * zoning/weapon/every other feature's own /sources. */
export function registerPeopleSources(ids: string[]): void {
  const known = sources()
  for (const id of ids) if (!known.includes(id)) known.push(id)
}

export function removePeopleSource(id: string): void {
  sourcesKnown = sources().filter((s) => s !== id)
}

/** Only the fields the real GET /people/status actually returns -
 * sources_known/calibrated/aligned live on getPeopleSources below, verified
 * against the running service. */
export function getPeopleStatus(): PeopleStatus {
  const { known, calibratedSet, alignedSet } = readiness()
  const phase = currentPhase()
  const warnings: string[] = []
  if (known.length < 2) {
    warnings.push('need >=2 registered cameras for cross-camera tracking')
  }
  const notReady = known.filter((id) => !calibratedSet.has(id) || !alignedSet.has(id))
  if (notReady.length > 0) {
    warnings.push(
      `camera(s) ${notReady.join(', ')} not yet calibrated+aligned (POST /calibration/rect, then /calibration/align)`,
    )
  }
  return {
    phase,
    person_scale: phase === 'running' ? 1.72 : null,
    room: phase === 'running' ? { xmin: -1, xmax: 11, ymin: -1, ymax: 7 } : null,
    fps: phase === 'running' ? 7.5 : null,
    warnings,
    error: null,
    cams_bootstrapped: phase === 'running' ? known : null,
    gates_loaded: phase === 'running' ? 0 : null,
    active_tracks: phase === 'running' ? currentTracks().length : null,
  }
}

export function getPeopleSources(): PeopleSources {
  const { known, calibratedSet, alignedSet } = readiness()
  return {
    sources_known: known,
    calibrated: known.filter((id) => calibratedSet.has(id)),
    aligned: known.filter((id) => alignedSet.has(id)),
  }
}

/** Consulted by zoneStore: a world zone counts against /people's own live
 * tracks now, not an independent fusion step, so it reads 0 until this is
 * true - see ai/features/zoning/api.py's post_zone. */
export function isPeopleRunning(): boolean {
  return currentPhase() === 'running'
}

/* A handful of tracks drifting around a fixed room, enough to make the live
   map watchable without pretending to be a real detector. Regenerated fresh
   each read from a deterministic walk, not stored, since nothing here needs
   these to persist across an unrelated read. */
function currentTracks(): TrackDict[] {
  const t = (Date.now() / 1000) % 1000
  const specs = [
    { id: 'track-1', cx: 4, cy: 3, r: 2.5, speed: 0.4, phase: 0 },
    { id: 'track-2', cx: 8, cy: 5, r: 1.8, speed: 0.6, phase: 2 },
    { id: 'track-3', cx: 6, cy: 6.5, r: 1.2, speed: 0.3, phase: 4 },
  ]
  return specs.map((s) => ({
    id: s.id,
    x: Number((s.cx + s.r * Math.cos(t * s.speed + s.phase)).toFixed(2)),
    y: Number((s.cy + s.r * Math.sin(t * s.speed + s.phase)).toFixed(2)),
    hits: 40,
    misses: 0,
  }))
}

export function getPeopleTracks(): TrackDict[] {
  return isPeopleRunning() ? currentTracks() : []
}

/** Tests only - module state would otherwise leak between them. */
export function resetPeopleStore(): void {
  sourcesKnown = null
  bootstrapStartedAt = null
}
