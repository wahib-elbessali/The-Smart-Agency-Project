import { registerMock, registerMockWriter } from '../registry'
import type { TicketTemplate, TicketTemplateBlock } from '@/api/types'
import { ApiError } from '@/api/errors'

/* One saved template per agency, kept for the session so a save is visible on
 * the next read - same idea as the other writable mock stores. An agency that
 * never saved gets the built-in default, exactly like the real backend. */
const DEFAULT: TicketTemplateBlock[] = [
  { type: 'text', content: 'Bienvenue chez nous' },
  { type: 'agency_name' },
  { type: 'ticket_number' },
  { type: 'service_name' },
  { type: 'date' },
]

const saved = new Map<string, TicketTemplateBlock[]>()

export function resetTicketTemplateStore(): void {
  saved.clear()
}

function agencyIdFrom(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

/** Mirrors the server: an uploaded image becomes a processed bitmap, anything
 * already processed passes through, and an empty template is refused. */
function process(blocks: TicketTemplateBlock[]): TicketTemplateBlock[] {
  if (blocks.length === 0) {
    throw new ApiError('http', 'Le template ne peut pas etre vide', 422)
  }
  return blocks.map((block) =>
    block.type === 'image' && 'content' in block
      ? { type: 'image', data: btoa('ª'.repeat(48 * 8)), rows: 8 }
      : block,
  )
}

registerMock<TicketTemplate>('GET /api/agencies/{id}/ticket-template', {
  normal: (path) => ({ template: saved.get(agencyIdFrom(path)) ?? DEFAULT }),
  empty: () => ({ template: DEFAULT }),
  large: () => ({ template: DEFAULT }),
})

registerMockWriter('PUT /api/agencies/{id}/ticket-template', (body, path) => {
  const template = process((body as TicketTemplate).template)
  saved.set(agencyIdFrom(path), template)
  return { template }
})
