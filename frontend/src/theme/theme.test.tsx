import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from './theme'
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  readStoredPreference,
  resolveTheme,
  useTheme,
} from './ThemeContext'
import { ThemeToggle } from '@/components/ThemeToggle'

/**
 * jsdom implements no matchMedia at all, so every test that cares about the OS
 * preference has to install one. This stub is deliberately minimal - it answers
 * the one query the theme asks and lets a test push a change through the
 * listener, which is the only behaviour worth exercising.
 */
function stubMatchMedia(prefersLight: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: prefersLight,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    /* Flips the OS setting and notifies, the way a real change event would. */
    _set(next: boolean) {
      query.matches = next
      for (const fn of listeners) fn()
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  )
  return query
}

function Probe() {
  const { preference, resolved } = useTheme()
  return <span data-testid="probe">{`${preference}/${resolved}`}</span>
}

function renderWithProvider(node = <Probe />) {
  return render(<ThemeProvider>{node}</ThemeProvider>)
}

const themeAttr = () => document.documentElement.dataset.theme

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readStoredPreference', () => {
  it('defaults to following the system', () => {
    expect(readStoredPreference()).toBe('system')
  })

  it('reads a stored choice back', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readStoredPreference()).toBe('light')
  })

  it('ignores a value that is not a theme', () => {
    // Anything could be in storage - an old key, a hand-edited value, another
    // app on the same origin. None of it should be stamped onto <html>.
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse')
    expect(readStoredPreference()).toBe('system')
  })

  it('survives localStorage throwing rather than taking the app down', () => {
    // Safari private browsing and any browser with site data blocked throw on
    // access. Failing to remember a colour must not fail to start.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStoredPreference()).toBe('system')
    spy.mockRestore()
  })
})

describe('isThemePreference', () => {
  it('accepts the three real values and nothing else', () => {
    expect(['light', 'dark', 'system'].every(isThemePreference)).toBe(true)
    expect([null, undefined, '', 'Light', 'auto', 0].some(isThemePreference)).toBe(false)
  })
})

describe('resolveTheme', () => {
  it('passes an explicit choice through untouched', () => {
    stubMatchMedia(true)
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('asks the system only when following it', () => {
    stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('light')
  })

  it('falls back to dark when the browser cannot report a preference', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(resolveTheme('system')).toBe('dark')
  })
})

describe('ThemeProvider', () => {
  it('stamps an explicit theme on <html>, never leaves it unset', () => {
    // The CSS keys on [data-theme='light'] with no media-query fallback, so an
    // absent attribute would silently mean "dark" and system users on a light
    // OS would get the wrong theme.
    stubMatchMedia(true)
    renderWithProvider()
    expect(themeAttr()).toBe('light')
  })

  it('honours a stored choice over the system', () => {
    stubMatchMedia(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    renderWithProvider()
    expect(screen.getByTestId('probe')).toHaveTextContent('dark/dark')
    expect(themeAttr()).toBe('dark')
  })

  it('follows the OS while set to system', () => {
    const query = stubMatchMedia(false)
    renderWithProvider()
    expect(themeAttr()).toBe('dark')

    /* act() because the change arrives from outside React - a media query
       listener, not a click - so nothing else would flush the state update and
       the effect that stamps the attribute. */
    act(() => query._set(true))
    expect(themeAttr()).toBe('light')
  })

  it('stops following the OS once a choice is made', () => {
    // Someone who explicitly picked dark does not want their wall display
    // flipping at sunrise because the machine did.
    const query = stubMatchMedia(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    renderWithProvider()
    expect(themeAttr()).toBe('dark')

    act(() => query._set(true))
    expect(themeAttr()).toBe('dark')
  })
})

describe('ThemeToggle', () => {
  const toggle = () => screen.getByRole('switch', { name: /dark mode/i })

  it('is a switch reporting whether dark is on', () => {
    stubMatchMedia(false)
    renderWithProvider(<ThemeToggle />)
    expect(toggle()).toBeChecked()
  })

  /* The switch shows the RESOLVED theme, not the stored preference. While
     following the system there is no explicit choice to show, and reporting
     "off" on a machine that is currently dark would be a lie. */
  it('reflects the system theme while still following it', () => {
    stubMatchMedia(true)
    renderWithProvider(<ThemeToggle />)

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(toggle()).not.toBeChecked()
  })

  it('flips the theme and persists an explicit choice', async () => {
    const user = userEvent.setup()
    stubMatchMedia(false)
    renderWithProvider(<ThemeToggle />)

    await user.click(toggle())

    expect(themeAttr()).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(toggle()).not.toBeChecked()
  })

  it('flips back again', async () => {
    const user = userEvent.setup()
    stubMatchMedia(true)
    renderWithProvider(<ThemeToggle />)

    await user.click(toggle())
    expect(themeAttr()).toBe('dark')

    await user.click(toggle())
    expect(themeAttr()).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  /* Pressing the switch replaces "follow the system" with a real choice, and
     the OS must stop overriding it from then on. */
  it('stops following the system once pressed', async () => {
    const user = userEvent.setup()
    const query = stubMatchMedia(true)
    renderWithProvider(<ThemeToggle />)
    expect(themeAttr()).toBe('light')

    await user.click(toggle())
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    act(() => query._set(false))
    act(() => query._set(true))
    expect(themeAttr()).toBe('dark')
  })
})
