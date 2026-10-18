import { fetchJson } from '../client'
import type { AiConfig, AiConfigPatch, AiConfigResult } from '../types'

/**
 * Detector tuning for the AI service - contracts/api.md §25. ADMIN only; the
 * backend proxies the AI service's own config API and keeps an audit entry
 * for every change.
 */

export function fetchAiConfig(signal?: AbortSignal): Promise<AiConfig> {
  return fetchJson<AiConfig>(
    { key: 'GET /api/ai/config', path: '/api/ai/config', auth: true },
    { signal },
  )
}

/** All-or-nothing: a rejected change is a 422 whose `errors` lists every problem. */
export function patchAiConfig(body: AiConfigPatch, signal?: AbortSignal): Promise<AiConfigResult> {
  return fetchJson<AiConfigResult>(
    { key: 'PATCH /api/ai/config', path: '/api/ai/config', method: 'PATCH', auth: true },
    { signal, body },
  )
}

export function reloadAiConfig(signal?: AbortSignal): Promise<AiConfigResult> {
  return fetchJson<AiConfigResult>(
    {
      key: 'POST /api/ai/config/reload',
      path: '/api/ai/config/reload',
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}
