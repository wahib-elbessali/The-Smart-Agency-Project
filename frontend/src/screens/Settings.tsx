import type { ReactNode } from 'react'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useSession } from '@/auth/SessionContext'
import { setRailPinned, useRailPinned } from '@/components/railPinned'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { cn } from '@/components/ui/cn'
import { useTheme, type ThemePreference } from '@/theme/ThemeContext'
import { Screen } from './Screen'

/**
 * Settings: preferences about the person rather than the data.
 *
 * Screens are deliberately NOT linked from here. An earlier version moved the
 * set-up screens (agencies, zones, devices...) into this page to shorten the
 * sidebar, and people could not find them - so every screen is back on the
 * sidebar, in sections, with Ctrl+K search for speed.
 *
 * Nothing here talks to the backend. Theme and sidebar state persist in this
 * browser, and the account block only reads the session - contracts/api.md
 * has no endpoint for editing your own profile or password, so this screen
 * offers neither rather than a form that cannot save.
 */
const THEME_OPTIONS: readonly { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export default function Settings() {
  const { user, signOut } = useSession()
  const { preference, setPreference } = useTheme()
  const pinned = useRailPinned()

  return (
    <Screen title="Settings" description="Appearance, sidebar and your account.">
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Appearance</h2>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-6">
            <Row label="Theme" hint="System follows your computer's setting.">
              <div
                role="radiogroup"
                aria-label="Theme"
                className="bg-panel-2 border-line flex rounded-lg border p-0.5"
              >
                {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={preference === value}
                    onClick={() => setPreference(value)}
                    className={cn(
                      'ease-soft flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent px-3 py-2 text-xs transition-all duration-150',
                      preference === value
                        ? 'bg-panel text-ink border-line shadow-panel border font-medium'
                        : 'text-ink-2 hover:text-ink',
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              label="Keep sidebar expanded"
              hint="Off: the sidebar opens while you hover it. Desktop only."
              inline
            >
              <Switch checked={pinned} onChange={setRailPinned} label="Keep sidebar expanded" />
            </Row>
          </PanelBody>
        </Panel>

        {user && (
          <Panel as="section">
            <PanelHeader>
              <h2 className="text-ink text-sm font-semibold">Account</h2>
            </PanelHeader>
            <PanelBody className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Avatar name={user.full_name} className="size-10" />
                <div className="min-w-0">
                  <div className="text-ink truncate text-sm font-medium">{user.full_name}</div>
                  <div className="text-ink-2 truncate text-xs">{user.email}</div>
                  <div className="text-ink-3 tracked mt-0.5 text-[10px]">{user.role}</div>
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={signOut} className="self-start">
                <LogOut className="size-3.5" aria-hidden />
                Sign out
              </Button>
            </PanelBody>
          </Panel>
        )}
      </div>
    </Screen>
  )
}

function Row({
  label,
  hint,
  inline = false,
  children,
}: {
  label: string
  hint: string
  inline?: boolean
  children: ReactNode
}) {
  return (
    <div className={inline ? 'flex items-center justify-between gap-4' : 'flex flex-col gap-2'}>
      <div>
        <div className="text-ink text-[0.8125rem] font-medium">{label}</div>
        <div className="text-ink-3 text-xs">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'ease-soft relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'bg-ink ease-soft size-5 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  )
}
