import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { ChevronDown, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { useSession } from '@/auth/SessionContext'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/components/ui/cn'
import { useTheme, type ThemePreference } from '@/theme/ThemeContext'

/**
 * The avatar in the top bar, and the menu it opens: who you are, Settings,
 * the theme, and Sign out.
 *
 * Sign out lives here so it is one click from every screen again - it had
 * only been reachable through Settings since the account block left the
 * sidebar.
 *
 * A real menu-button pattern (aria-haspopup, role="menu", arrow keys move
 * between items, Escape returns focus to the avatar) rather than a styled
 * popover, so a keyboard or screen-reader user gets the behaviour they expect.
 * Closes on any pointer press outside it.
 */
const THEMES: readonly { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

const ITEM =
  'ease-soft flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-offset-0'

export function AccountMenu() {
  const { user, signOut } = useSession()
  const { preference, setPreference } = useTheme()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    rootRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null

  const items = () => [
    ...(rootRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
  ]

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
    all[next]?.focus()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account: ${user.full_name}`}
        className={cn(
          'ease-soft flex cursor-pointer items-center gap-1 rounded-md p-1 transition-colors duration-150',
          open ? 'bg-panel-2' : 'hover:bg-panel-2',
        )}
      >
        <Avatar name={user.full_name} />
        <ChevronDown
          className={cn(
            'text-ink-3 ease-soft size-3.5 transition-transform duration-150',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKey}
          className="bg-panel border-line shadow-raised absolute top-full right-0 z-30 mt-2 w-64 rounded-lg border p-1"
        >
          <div className="flex items-center gap-3 px-2 pt-2 pb-3">
            <Avatar name={user.full_name} className="size-9" />
            <div className="min-w-0">
              <div className="text-ink truncate text-sm font-medium">{user.full_name}</div>
              <div className="text-ink-3 truncate text-xs">{user.email}</div>
              <div className="text-ink-3 tracked mt-0.5 text-[10px]">{user.role}</div>
            </div>
          </div>

          <div className="border-line border-t pt-1">
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(ITEM, 'text-ink-2 hover:text-ink hover:bg-panel-2')}
            >
              <Settings className="size-4" aria-hidden />
              Settings
            </Link>
          </div>

          <div className="border-line mt-1 border-t px-2 pt-2 pb-1">
            <div className="text-ink-3 tracked mb-2 text-[10px]" id={`${menuId}-theme`}>
              Theme
            </div>
            <div
              role="group"
              aria-labelledby={`${menuId}-theme`}
              className="bg-panel-2 border-line flex rounded-md border p-0.5"
            >
              {THEMES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={preference === value}
                  onClick={() => setPreference(value)}
                  className={cn(
                    'ease-soft flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border border-transparent py-1 text-xs transition-colors duration-150',
                    preference === value
                      ? 'bg-panel text-ink border-line'
                      : 'text-ink-3 hover:text-ink',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-line mt-1 border-t pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className={cn(ITEM, 'text-danger hover:bg-danger/10')}
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
