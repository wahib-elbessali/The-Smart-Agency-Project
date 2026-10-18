import { registerMock, registerMockWriter } from '../registry'
import type { AiConfig, AiConfigPatch } from '@/api/types'
import * as store from '../aiConfigStore'

/** contracts/api.md §25 - field names from the AI service's GET/PATCH /config. */

registerMock<AiConfig>('GET /api/ai/config', {
  normal: () => store.getAiConfig(),
  empty: () => store.getAiConfig(),
  large: () => store.getAiConfig(),
})

registerMockWriter('PATCH /api/ai/config', (body) => store.patchAiConfig(body as AiConfigPatch))
registerMockWriter('POST /api/ai/config/reload', () => store.reloadAiConfig())
