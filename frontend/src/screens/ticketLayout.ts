import type { TicketTemplateBlock } from '@/api/types'

/**
 * Pure rules for the ticket-layout editor, kept out of the component so they
 * can be tested without a DOM. The backend (ticket_template_service.py) stays
 * the authority - everything here only catches what it would refuse, early,
 * in plain words.
 */

export type BlockType = TicketTemplateBlock['type']

export const BLOCK_TYPES: { type: BlockType; label: string; hint: string }[] = [
  { type: 'text', label: 'Text', hint: 'A line of fixed text' },
  { type: 'agency_name', label: 'Branch name', hint: 'Filled in when printed' },
  { type: 'ticket_number', label: 'Ticket number', hint: 'Filled in when printed' },
  { type: 'service_name', label: 'Service name', hint: 'Filled in when printed' },
  { type: 'date', label: 'Date', hint: 'Filled in when printed' },
  { type: 'qrcode', label: 'QR code', hint: 'Encodes the text you give it' },
  { type: 'image', label: 'Image', hint: 'A logo, printed in black and white' },
  { type: 'spacing', label: 'Blank lines', hint: 'Empty space between blocks' },
]

/** The same default the backend serves for a branch that never saved one. */
export const DEFAULT_TEMPLATE: TicketTemplateBlock[] = [
  { type: 'text', content: 'Bienvenue chez nous' },
  { type: 'agency_name' },
  { type: 'ticket_number' },
  { type: 'service_name' },
  { type: 'date' },
]

/** Printer width in dots and the packed layout the backend returns for images. */
export const PRINTER_WIDTH = 384
const ROW_BYTES = PRINTER_WIDTH / 8

export function newBlock(type: BlockType): TicketTemplateBlock {
  switch (type) {
    case 'text':
      return { type: 'text', content: '' }
    case 'qrcode':
      return { type: 'qrcode', content: '' }
    case 'image':
      return { type: 'image', content: '' }
    case 'spacing':
      return { type: 'spacing', lines: 1 }
    default:
      return { type }
  }
}

export function moveBlock<T>(blocks: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) {
    return blocks
  }
  const next = [...blocks]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

export function removeBlock<T>(blocks: T[], index: number): T[] {
  return blocks.filter((_, i) => i !== index)
}

export function replaceBlock<T>(blocks: T[], index: number, block: T): T[] {
  return blocks.map((existing, i) => (i === index ? block : existing))
}

/** Which block is wrong and why, in the order they print. Empty = saveable. */
export function validateTemplate(blocks: TicketTemplateBlock[]): string[] {
  if (blocks.length === 0) return ['Add at least one block - an empty ticket prints nothing.']
  const problems: string[] = []
  blocks.forEach((block, i) => {
    const where = `Block ${i + 1}`
    if (block.type === 'text' && block.content.trim() === '') {
      problems.push(`${where} (text) is empty.`)
    } else if (block.type === 'qrcode' && block.content.trim() === '') {
      problems.push(`${where} (QR code) needs the text or link it should encode.`)
    } else if (block.type === 'image' && 'content' in block && block.content.trim() === '') {
      problems.push(`${where} (image) needs a file - choose one or remove the block.`)
    } else if (block.type === 'spacing') {
      if (!Number.isInteger(block.lines) || block.lines < 0 || block.lines > 20) {
        problems.push(`${where} (blank lines) must be a whole number from 0 to 20.`)
      }
    }
  })
  return problems
}

/**
 * Unpack the backend's processed image (384 dots wide, 48 bytes per row, most
 * significant bit first, bit 1 = black) into rows of booleans, true = black.
 * Returns [] for anything that is not valid base64 of exactly 48 bytes per row
 * rather than throwing - a preview must never take the editor down.
 */
export function decodeBitmap(data: string, rows: number): boolean[][] {
  let raw: string
  try {
    raw = atob(data)
  } catch {
    return []
  }
  if (rows < 1 || raw.length !== ROW_BYTES * rows) return []
  const result: boolean[][] = []
  for (let y = 0; y < rows; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < PRINTER_WIDTH; x += 1) {
      const byte = raw.charCodeAt(y * ROW_BYTES + (x >> 3))
      row.push((byte & (1 << (7 - (x & 7)))) !== 0)
    }
    result.push(row)
  }
  return result
}

/** Read a chosen file as a base64 data URI, the form the backend accepts. */
export function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

/** True when the layout is exactly the built-in default. */
export function isDefaultTemplate(blocks: TicketTemplateBlock[]): boolean {
  return JSON.stringify(blocks) === JSON.stringify(DEFAULT_TEMPLATE)
}
