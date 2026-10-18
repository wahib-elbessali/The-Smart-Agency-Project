import { describe, expect, it } from 'vitest'
import type { SetupItem } from '@/api/types'
import { groupSetupItems, isExpanded, progressPercent, summaryLine } from './setupProgress'

const item = (key: string, group: string, status: SetupItem['status']): SetupItem => ({
  key,
  group,
  label: key,
  why: '',
  status,
  detail: '',
  link: null,
})

describe('groupSetupItems', () => {
  it('keeps the server order, which is the order the steps depend on each other', () => {
    const groups = groupSetupItems([
      item('a', 'Foundation', 'done'),
      item('b', 'Vision', 'todo'),
      item('c', 'Foundation', 'todo'),
      item('d', 'Queue', 'done'),
    ])
    expect(groups.map((g) => g.name)).toEqual(['Foundation', 'Vision', 'Queue'])
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['a', 'c'])
  })

  it('counts only done steps per group - unknown is not done', () => {
    const [group] = groupSetupItems([
      item('a', 'Vision', 'done'),
      item('b', 'Vision', 'unknown'),
      item('c', 'Vision', 'todo'),
    ])
    expect(group?.done).toBe(1)
  })
})

describe('progress helpers', () => {
  it('rounds the percentage and survives an empty list', () => {
    expect(progressPercent(0, 14)).toBe(0)
    expect(progressPercent(9, 14)).toBe(64)
    expect(progressPercent(14, 14)).toBe(100)
    expect(progressPercent(0, 0)).toBe(0)
  })

  it('opens by itself while work is left and tucks away when done, unless the user chose', () => {
    expect(isExpanded(false, null)).toBe(true)
    expect(isExpanded(true, null)).toBe(false)
    expect(isExpanded(true, true)).toBe(true)
    expect(isExpanded(false, false)).toBe(false)
  })

  it('summarises, and says plainly when a step could not be checked', () => {
    expect(summaryLine(14, 14, 0)).toBe('Everything is set up.')
    expect(summaryLine(9, 14, 0)).toBe('9 of 14 done · 5 to do')
    expect(summaryLine(9, 14, 2)).toBe('9 of 14 done · 3 to do · 2 could not be checked')
  })
})
