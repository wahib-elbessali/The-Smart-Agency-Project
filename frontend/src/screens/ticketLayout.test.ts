import { describe, expect, it } from 'vitest'
import type { TicketTemplateBlock } from '@/api/types'
import {
  DEFAULT_TEMPLATE,
  decodeBitmap,
  isDefaultTemplate,
  moveBlock,
  newBlock,
  removeBlock,
  replaceBlock,
  validateTemplate,
} from './ticketLayout'

describe('block list operations', () => {
  it('moves a block and leaves the original list untouched', () => {
    const list = ['a', 'b', 'c']
    expect(moveBlock(list, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveBlock(list, 2, 1)).toEqual(['a', 'c', 'b'])
    expect(list).toEqual(['a', 'b', 'c'])
  })

  it('ignores a move that goes nowhere or off the ends', () => {
    const list = ['a', 'b']
    expect(moveBlock(list, 0, 0)).toBe(list)
    expect(moveBlock(list, 0, -1)).toBe(list)
    expect(moveBlock(list, 1, 2)).toBe(list)
  })

  it('removes and replaces by position', () => {
    expect(removeBlock(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(replaceBlock(['a', 'b'], 1, 'z')).toEqual(['a', 'z'])
  })

  it('creates a sensible empty block of every type', () => {
    expect(newBlock('text')).toEqual({ type: 'text', content: '' })
    expect(newBlock('spacing')).toEqual({ type: 'spacing', lines: 1 })
    expect(newBlock('ticket_number')).toEqual({ type: 'ticket_number' })
    expect(newBlock('image')).toEqual({ type: 'image', content: '' })
  })
})

describe('validateTemplate', () => {
  it('accepts the default layout', () => {
    expect(validateTemplate(DEFAULT_TEMPLATE)).toEqual([])
  })

  it('refuses an empty ticket', () => {
    expect(validateTemplate([])[0]).toMatch(/at least one block/i)
  })

  it('names the block that is wrong, by its position', () => {
    const blocks: TicketTemplateBlock[] = [
      { type: 'agency_name' },
      { type: 'text', content: '   ' },
      { type: 'qrcode', content: '' },
      { type: 'image', content: '' },
      { type: 'spacing', lines: -1 },
    ]
    const problems = validateTemplate(blocks)
    expect(problems).toHaveLength(4)
    expect(problems[0]).toMatch(/^Block 2 \(text\)/)
    expect(problems[1]).toMatch(/^Block 3 \(QR code\)/)
    expect(problems[2]).toMatch(/^Block 4 \(image\)/)
    expect(problems[3]).toMatch(/^Block 5 \(blank lines\)/)
  })

  it('lets an already-saved image through - it has data, not content', () => {
    expect(validateTemplate([{ type: 'image', data: 'AAAA', rows: 1 }])).toEqual([])
  })

  it('rejects fractional or absurd blank-line counts', () => {
    expect(validateTemplate([{ type: 'spacing', lines: 1.5 }])).toHaveLength(1)
    expect(validateTemplate([{ type: 'spacing', lines: 21 }])).toHaveLength(1)
    expect(validateTemplate([{ type: 'spacing', lines: 0 }])).toEqual([])
  })
})

describe('decodeBitmap', () => {
  const rowOf = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

  it('unpacks 48 bytes per row, most significant bit first, 1 = black', () => {
    const bytes = new Array<number>(48).fill(0)
    bytes[0] = 0b10000000 // first dot black
    bytes[1] = 0b00000001 // dot 15 black
    bytes[47] = 0b00000001 // last dot black
    const rows = decodeBitmap(rowOf(bytes), 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(384)
    expect(rows[0]?.[0]).toBe(true)
    expect(rows[0]?.[1]).toBe(false)
    expect(rows[0]?.[15]).toBe(true)
    expect(rows[0]?.[383]).toBe(true)
    expect(rows[0]?.filter(Boolean)).toHaveLength(3)
  })

  it('reads several rows in order', () => {
    const first = new Array<number>(48).fill(0xff)
    const second = new Array<number>(48).fill(0)
    const rows = decodeBitmap(rowOf([...first, ...second]), 2)
    expect(rows[0]?.every(Boolean)).toBe(true)
    expect(rows[1]?.some(Boolean)).toBe(false)
  })

  it('returns nothing, rather than throwing, for bad input', () => {
    expect(decodeBitmap('***', 1)).toEqual([])
    expect(decodeBitmap(rowOf([1, 2, 3]), 1)).toEqual([])
    expect(decodeBitmap(rowOf(new Array<number>(48).fill(0)), 2)).toEqual([])
    expect(decodeBitmap('', 0)).toEqual([])
  })
})

describe('isDefaultTemplate', () => {
  it('recognises the built-in layout and nothing else', () => {
    expect(isDefaultTemplate([...DEFAULT_TEMPLATE])).toBe(true)
    expect(isDefaultTemplate([...DEFAULT_TEMPLATE, { type: 'date' }])).toBe(false)
  })
})
