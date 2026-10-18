import type { DoorAccessSummary } from '@/api/types'

const REASON_LABEL: Record<string, string> = {
  unknown_card: 'Unknown card',
  employee_inactive: 'Inactive employee',
  zone_denied: 'Not allowed in this zone',
  rejected: 'Refused by attendance rules',
}

/** An unknown reason code is shown as-is rather than hidden. */
export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason
}

/**
 * The one-line evidence for a door. Deliberately describes, never diagnoses:
 * a flaky reader, a worn card and someone testing cards all look alike from
 * here, so what is shown is how many failures and how many DIFFERENT cards -
 * one card failing over and over reads very differently from many cards
 * failing once each.
 */
export function describeDoor(door: DoorAccessSummary, windowMinutes: number): string {
  const cards = door.distinct_cards_in_window
  const parts = [
    `${door.failures_in_window} failed in the last ${windowMinutes} min`,
    `${cards} ${cards === 1 ? 'card' : 'different cards'}`,
    `${door.failures_24h} in 24 h`,
  ]
  return parts.join(' · ')
}
