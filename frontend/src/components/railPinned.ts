import { useSyncExternalStore } from 'react'

/**
 * Whether the desktop rail stays expanded, shared by the rail's own pin button
 * and the switch on the Settings screen - two controls for one fact, so it is
 * a tiny store both subscribe to rather than state owned by either.
 *
 * Remembered per browser. Storage can throw (private windows, blocked site
 * data), and forgetting a layout preference is survivable, so every access is
 * guarded and the default is collapsed.
 */
const KEY = 'smartagency.rail-pinned'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

let pinned = read()

export function setRailPinned(next: boolean): void {
  pinned = next
  try {
    localStorage.setItem(KEY, String(next))
  } catch {
    /* Applies for this session, just not remembered. */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRailPinned(): boolean {
  return useSyncExternalStore(subscribe, () => pinned)
}
