import { createContext, use } from 'react'

/**
 * Theme context and its hook, kept out of the provider file so that file
 * exports only a component - otherwise fast refresh stops working for it. Same
 * split, and the same reason, as SessionContext.
 */

/** What the person chose. `system` follows the OS setting as it changes. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** What is actually on screen. `system` has been resolved away by this point. */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference(preference: ThemePreference): void
}

export const ThemeContext = createContext<ThemeValue | null>(null)

export function useTheme(): ThemeValue {
  const value = use(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider')
  return value
}

/** Where the choice is persisted. Exported so the tests and the no-flash
 *  bootstrap in index.html cannot drift apart from this module. */
export const THEME_STORAGE_KEY = 'smartagency.theme'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * Reads the stored choice, defaulting to `system`.
 *
 * localStorage access throws rather than returning null in a few real cases -
 * Safari private browsing, and any browser with site data blocked - so this
 * cannot be a bare read. A dashboard that fails to start because it could not
 * remember a colour preference would be a poor trade.
 */
export function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function writeStoredPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* Not being able to persist is survivable: the choice still applies for
       this session, it just will not be remembered. Failing loudly here would
       turn a storage restriction into a broken app. */
  }
}

/** The OS preference. Defaults to dark, which is this product's primary mode. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

/**
 * Stamps the resolved theme onto <html>.
 *
 * ALWAYS an explicit "light" or "dark" - never absent, never "system". The CSS
 * therefore needs one override block keyed on [data-theme='light'] rather than
 * that block plus a duplicate inside a prefers-color-scheme media query, and
 * there is no way for the two to drift out of sync. Resolving in script is the
 * cheaper half of the problem.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolved
}
