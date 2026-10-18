import type { SetupItem } from '@/api/types'

export interface SetupGroup {
  name: string
  items: SetupItem[]
  done: number
}

/** Groups in the order the server listed them, which is the order the steps
 * depend on each other - so this keeps order rather than sorting. */
export function groupSetupItems(items: SetupItem[]): SetupGroup[] {
  const groups: SetupGroup[] = []
  for (const item of items) {
    let group = groups.find((g) => g.name === item.group)
    if (!group) {
      group = { name: item.group, items: [], done: 0 }
      groups.push(group)
    }
    group.items.push(item)
    if (item.status === 'done') group.done += 1
  }
  return groups
}

export function progressPercent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((100 * done) / total)
}

/** The panel opens on its own while there is work left and tucks itself away
 * once everything is done; an explicit choice by the user always wins. */
export function isExpanded(complete: boolean, userChoice: boolean | null): boolean {
  return userChoice ?? !complete
}

/** One line for the collapsed state. */
export function summaryLine(done: number, total: number, unknown: number): string {
  if (done === total) return 'Everything is set up.'
  const left = total - done - unknown
  const parts = [`${done} of ${total} done`]
  if (left > 0) parts.push(`${left} to do`)
  if (unknown > 0) parts.push(`${unknown} could not be checked`)
  return parts.join(' · ')
}
