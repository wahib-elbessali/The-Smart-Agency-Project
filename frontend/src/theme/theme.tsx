import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ThemeContext,
  applyTheme,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type ThemePreference,
  type ResolvedTheme,
} from './ThemeContext'

/**
 * Holds the colour-scheme choice and keeps <html data-theme> in step with it.
 *
 * Three states rather than a boolean toggle, because "follow the system" is a
 * real answer and not the same as either fixed mode: a machine that dims its
 * display in the evening should take the dashboard with it, and a two-way
 * switch cannot express that.
 *
 * The initial value is read synchronously in useState's initialiser rather than
 * in an effect. An effect would render one frame with the default theme first,
 * which is a visible flash on every load - and the flash is worse here than in
 * most apps, because the two themes are near-black and near-white.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference))

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    writeStoredPreference(next)
    setResolved(resolveTheme(next))
  }, [])

  /* Re-resolve when the OS flips, but only while following it. A person who
     has explicitly chosen light does not want their screen changing at sunset
     because the OS did. */
  useEffect(() => {
    if (preference !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return

    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setResolved(query.matches ? 'light' : 'dark')

    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [preference])

  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}
