import { ApiError } from '@/api/errors'
import type {
  AiApplyMode,
  AiConfig,
  AiConfigPatch,
  AiConfigResult,
  AiConfigSection,
  AiConfigValue,
} from '@/api/types'

/**
 * A writable copy of the AI service's config for mock mode - values, apply
 * modes and the rules from contracts/ai-service.md (GET/PATCH /config).
 *
 * Mirrors the real behaviour that matters to the screen: a change is
 * all-or-nothing, a restart-only key is refused without `persist` and then
 * lands under `pending_restart` instead of changing the running value, and
 * `startup_config` stays what it was at "boot" so a live change shows as a
 * difference.
 */

const DEFAULTS: Record<string, AiConfigSection> = {
  detector: { backend: 'auto' },
  weapon: { conf: 0.25, imgsz: 640, update_interval: 2.0 },
  fire: { conf: 0.25, imgsz: 1280, update_interval: 2.0 },
  zoning: { weights: null, imgsz: 1280, conf: 0.25, update_interval: 2.0 },
  emotion: { det_size: 640, update_interval: 2.0 },
  wanted: {
    threshold: 0.5,
    min_face_px: 30,
    det_size: 640,
    update_interval: 2.0,
    confirm_cycles: 2,
    hold_cycles: 5,
  },
  employee_activity: { poll_interval: 2.0, absence_seconds: 300.0 },
  person_tracking: {
    weights: null,
    conf: 0.25,
    update_interval: 2.0,
    gate_pw: 1.638,
    max_lost_s: 24.0,
    cam_support_min: 2,
    diffusion_revive: false,
  },
  face: { pack: 'buffalo_s' },
}

const MODES: Record<string, Record<string, AiApplyMode>> = {
  detector: { backend: 'restart' },
  weapon: { conf: 'live', imgsz: 'live', update_interval: 'live' },
  fire: { conf: 'live', imgsz: 'live', update_interval: 'live' },
  zoning: { weights: 'restart', imgsz: 'live', conf: 'live', update_interval: 'live' },
  emotion: { det_size: 'restart', update_interval: 'live' },
  wanted: {
    threshold: 'live',
    min_face_px: 'live',
    det_size: 'restart',
    update_interval: 'live',
    confirm_cycles: 'live',
    hold_cycles: 'live',
  },
  employee_activity: { poll_interval: 'live', absence_seconds: 'live' },
  person_tracking: {
    weights: 'restart',
    conf: 'live',
    update_interval: 'live',
    gate_pw: 'next_start',
    max_lost_s: 'next_start',
    cam_support_min: 'next_start',
    diffusion_revive: 'next_start',
  },
  face: { pack: 'restart' },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let running = clone(DEFAULTS)
let startup = clone(DEFAULTS)
let pending: Record<string, AiConfigSection> = {}

export function resetAiConfig(): void {
  running = clone(DEFAULTS)
  startup = clone(DEFAULTS)
  pending = {}
}

export function getAiConfig(): AiConfig {
  return {
    config: clone(running),
    apply_modes: clone(MODES),
    startup_config: clone(startup),
    pending_restart: clone(pending),
  }
}

function problem(
  feature: string,
  key: string,
  value: AiConfigValue,
  persist: boolean,
): string | null {
  const current = DEFAULTS[feature]?.[key]
  const expected = current === null ? 'string' : typeof current
  if (typeof value !== expected) return `${feature}.${key} should be ${expected}`
  if (typeof value === 'number') {
    if (key === 'conf' && !(value > 0 && value <= 1)) {
      return `${feature}.${key} must be in (0, 1], got ${value}`
    }
    if (key === 'imgsz' && (value < 32 || value > 4096 || value % 32 !== 0)) {
      return `${feature}.${key} must be in [32, 4096] and a multiple of 32, got ${value}`
    }
    if (key.endsWith('interval') && (value < 0.05 || value > 3600)) {
      return `${feature}.${key} must be in [0.05, 3600], got ${value}`
    }
    if (feature === 'wanted' && key === 'threshold' && (value < 0.25 || value > 1)) {
      return `wanted.threshold must be in [0.25, 1], got ${value} (below 0.25 the matcher false-alarms constantly)`
    }
  }
  if (MODES[feature]?.[key] === 'restart' && !persist) {
    return `${feature}.${key} only changes on restart; send persist=true to write it to config.json for the next start`
  }
  return null
}

export function patchAiConfig({ changes, persist }: AiConfigPatch): AiConfigResult {
  const errors: string[] = []
  for (const [feature, values] of Object.entries(changes)) {
    if (!(feature in DEFAULTS)) {
      errors.push(`unknown section '${feature}'; valid: ${Object.keys(DEFAULTS).join(', ')}`)
      continue
    }
    for (const [key, value] of Object.entries(values)) {
      if (!(key in (DEFAULTS[feature] ?? {}))) {
        errors.push(`unknown key '${feature}.${key}'`)
        continue
      }
      const message = problem(feature, key, value, persist)
      if (message !== null) errors.push(message)
    }
  }
  if (errors.length > 0) throw new ApiError('http', 'config not changed', 422, errors)

  const result: AiConfigResult = {
    applied: {},
    pending_restart: {},
    previous: {},
    persisted: persist,
  }
  for (const [feature, values] of Object.entries(changes)) {
    for (const [key, value] of Object.entries(values)) {
      const mode = MODES[feature]?.[key] ?? 'live'
      if (mode === 'restart') {
        pending[feature] = { ...pending[feature], [key]: value }
        result.pending_restart[feature] = { ...result.pending_restart[feature], [key]: value }
        continue
      }
      result.previous[feature] = { ...result.previous[feature], [key]: running[feature]![key]! }
      running[feature] = { ...running[feature], [key]: value }
      result.applied[feature] = { ...result.applied[feature], [key]: { value, mode } }
      if (persist) startup[feature] = { ...startup[feature], [key]: value }
    }
  }
  return result
}

/** The mock has no file to re-read, so a reload is a no-op that reports nothing applied. */
export function reloadAiConfig(): AiConfigResult {
  return { applied: {}, pending_restart: clone(pending), previous: {}, persisted: false }
}
