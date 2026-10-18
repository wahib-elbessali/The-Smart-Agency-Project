import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  CircleHelp,
  FlaskConical,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { MOCK_SCENARIO, USE_MOCKS } from '@/api/config'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { canReach } from '@/auth/access'
import { landingPathFor } from '@/auth/landing'
import { SCREEN_SECTIONS, SCREENS } from '@/auth/screens'
import { CommandPalette, type PaletteEntry } from '@/components/CommandPalette'
import { setRailPinned, useRailPinned } from '@/components/railPinned'
import { AccountMenu } from '@/components/AccountMenu'
import { AlertsBell } from '@/components/AlertsBell'
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary'
import { Logo } from '@/components/Logo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'
import { controlClass } from '@/components/ui/control'

/** Rail entries that are not in SCREENS, so the phone bar and the search can
 *  still name them. */
const UTILITY: readonly PaletteEntry[] = [
  {
    to: '/settings',
    label: 'Settings',
    description: 'Theme, sidebar and your account.',
    icon: Settings,
    section: 'General',
  },
  {
    to: '/help',
    label: 'Help',
    description: 'What each screen is for.',
    icon: CircleHelp,
    section: 'General',
  },
]

/** The screen the top bar's bell opens - and so the one screen the desktop
 *  sidebar leaves out. */
const ALERTS_PATH = '/alerts'

/** Shown on the search button, so the shortcut is learnable from the rail. */
const SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

export function AppShell() {
  // Keying the main region on pathname replays the enter animation per route,
  // so navigation reads as a transition rather than an instant swap.
  const { pathname } = useLocation()
  const { user } = useSession()
  const scope = useScope()
  const pinned = useRailPinned()
  const isAdmin = user?.role === 'ADMIN'

  /* Only an ADMIN has more than one branch to switch between, so only an
     ADMIN needs this fetched. The switcher is the ONE place scope changes
     (UX_AUDIT.md findings 1 and 2): every screen reads this choice instead of
     running its own agency picker. */
  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  /* A branch remembered across a reload may have been deleted since (in another
     tab, or by someone else). Holding it would make every screen ask for a
     branch that is not there, so once the list is known, let go of a choice
     that is not in it. */
  const knownBranchIds = agencies.data?.map((agency) => agency.id)
  const heldBranchId = scope.agencyId
  const leaveBranch = scope.leave
  useEffect(() => {
    if (knownBranchIds && heldBranchId && !knownBranchIds.includes(heldBranchId)) leaveBranch()
  }, [knownBranchIds, heldBranchId, leaveBranch])

  /* Only what this role can actually use. A link that answers with a refusal
     is not a link, and the nav is the one place that has to be true. */
  const nav = SCREENS.filter(({ to }) => canReach(user?.role, to))
  /* Every reachable screen is on the rail, in sections. An empty section is
     dropped, so an agent's three screens do not sit under three headings. */
  const sections = SCREEN_SECTIONS.map((section) => ({
    ...section,
    screens: nav.filter(({ group }) => group === section.group),
  })).filter(({ screens }) => screens.length > 0)
  const searchable: PaletteEntry[] = [
    ...sections.flatMap(({ title, screens }) =>
      screens.map((entry) => ({ ...entry, section: title })),
    ),
    ...UTILITY,
  ]
  const [searchOpen, setSearchOpen] = useState(false)

  /* Below md the nav is a full-screen menu behind a button rather than a
     column. Laid out inline it wrapped into a block of links that pushed every
     screen's content most of the way down a phone. */
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  const isAt = (to: string) => pathname === to || pathname.startsWith(`${to}/`)
  const current = searchable.find(({ to }) => isAt(to))

  /* Ctrl+K anywhere, Cmd+K on a Mac. Taken even from inside a text field:
     no screen here uses the combination for anything else. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setMenuOpen(false)
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  /* The URL is the other way in, and hiding the link without closing it would
     leave the boundary half-applied. Sent to where their role starts rather
     than to a refusal, because there is nothing here for them to act on.
     Guarded once for every child route: this is the layout all of them share. */
  if (!canReach(user?.role, pathname)) {
    return <Navigate to={landingPathFor(user?.role)} replace />
  }

  return (
    /* No background here on purpose. The glow lives on <body>, and an opaque
       fill on the app root would paint straight over it - which also takes the
       translucent cards with it, since glass with nothing behind it is just a
       dark rectangle. */
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="bg-accent text-on-accent sr-only rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>

      {/* Phone-only bar. Opaque, unlike the desktop sidebar: it stays pinned
          while the page scrolls under it, and glass over moving content reads
          as a smear. The current screen's name sits here because the menu
          that would otherwise show it is closed. */}
      <div className="bg-canvas/95 border-line sticky top-0 z-40 flex items-center gap-3 border-b px-4 py-3 backdrop-blur md:hidden">
        <Logo size={20} />
        <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">
          {current?.label ?? 'SmartAgency'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          {menuOpen ? (
            <X className="size-4" aria-hidden />
          ) : (
            <Menu className="size-4" aria-hidden />
          )}
        </Button>
      </div>

      {/* Desktop: a slim floating rail of icon chips - search, then every
          screen this role can open in labelled sections, Help and Settings
          at the foot, the pin button under them.
          Unpinned, it widens to show labels while hovered (or while KEYBOARD
          focus is inside it, so tabbing gets them too) and slides OVER the page,
          because a layout that reflows whenever the pointer drifts left makes
          every chart jump. Pinned, it stays wide and the reserved column
          widens with it, so nothing sits underneath.

          :focus-visible, not :focus-within. Clicking a link leaves focus on
          it, so with focus-within the rail stayed open after the pointer
          left; a mouse click never sets focus-visible, so it now closes the
          moment the pointer does, while Tab still opens it.

          The <nav> itself is only the reserved column; the visible panel is
          the fixed child. On a phone neither applies: the nav is a sheet under
          the top bar, and every rail rule below is md:-prefixed. */}
      <nav
        id="main-nav"
        aria-label="Main"
        className={cn(
          'md:ease-soft shrink-0 md:block md:transition-[width] md:duration-300',
          pinned ? 'md:w-[16.25rem]' : 'md:w-[5.5rem]',
          menuOpen
            ? 'bg-canvas fixed inset-x-0 top-[3.3rem] bottom-0 z-30 flex flex-col overflow-y-auto pt-3'
            : 'hidden',
        )}
      >
        {/* Its own opaque surface: expanded, it overlays the page, and labels
            over card text would be unreadable. No visible scrollbar: an
            admin's fifteen screens fit on a 1080p display, and on a shorter
            one the rail still scrolls - a bar beside a column of round chips
            just reads as a rendering fault. */}
        <div
          data-pinned={pinned}
          className={cn(
            'group/rail flex flex-1 flex-col pb-4',
            'md:bg-panel md:border-edge md:shadow-panel md:scrollbar-none md:fixed md:top-3 md:bottom-3 md:left-3 md:z-40 md:overflow-x-hidden md:overflow-y-auto md:rounded-xl md:border md:py-3',
            'md:ease-soft md:transition-[width,box-shadow] md:duration-300',
            pinned
              ? 'md:w-60'
              : 'md:hover:shadow-raised md:has-[:focus-visible]:shadow-raised md:w-16 md:has-[:focus-visible]:w-60 md:hover:w-60',
          )}
        >
          <div className="hidden items-center gap-3 px-2 pb-3 md:flex">
            <span className="mx-2 grid size-8 shrink-0 place-items-center">
              <Logo size={24} />
            </span>
            <Label className="text-ink font-display text-[0.95rem] font-semibold tracking-wide">
              Smart<span className="text-ink-3 font-normal">Agency</span>
            </Label>
          </div>

          {/* Phone only. On a desktop the top bar's search is the one search -
              two controls for the same palette read as two features. A phone
              has no top bar, so the sheet keeps its own. */}
          <div className="px-3 pb-1 md:hidden">
            <button
              type="button"
              onClick={() => {
                closeMenu()
                setSearchOpen(true)
              }}
              aria-keyshortcuts="Control+K Meta+K"
              className={cn(
                RAIL_ROW,
                'text-ink-2 hover:text-ink hover:bg-panel-2/70 w-full cursor-pointer',
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center">
                <Search className="size-[0.95rem]" aria-hidden />
              </span>
              <Label className="flex flex-1 items-center justify-between gap-2 pr-1">
                Search
                <kbd className="border-edge text-ink-3 rounded-md border px-1 py-0.5 text-[10px]">
                  {SHORTCUT}
                </kbd>
              </Label>
            </button>
          </div>

          {sections.map(({ group, title, screens }) => (
            <div key={group} role="group" aria-label={title}>
              <SectionHeading title={title} />
              <ul className="flex flex-col gap-0.5 px-3 md:px-2">
                {screens.map(({ to, label, icon }) => (
                  /* Alerts has one door on a desktop: the bell in the top bar,
                     which also carries the open count. A sidebar entry beside
                     it was a second link to the same screen. A phone has no
                     top bar, so the phone menu keeps the entry. */
                  <li key={to} className={to === ALERTS_PATH ? 'md:hidden' : undefined}>
                    <RailLink to={to} label={label} icon={icon} onNavigate={closeMenu} />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <ul className="mt-auto flex flex-col gap-0.5 px-3 pt-4 md:px-2">
            <li>
              <RailLink to="/help" label="Help" icon={CircleHelp} onNavigate={closeMenu} />
            </li>
            <li>
              <RailLink to="/settings" label="Settings" icon={Settings} onNavigate={closeMenu} />
            </li>
            {/* Desktop only: a phone has no rail to pin. */}
            <li className="hidden md:block">
              <button
                type="button"
                onClick={() => setRailPinned(!pinned)}
                aria-pressed={pinned}
                aria-label="Keep sidebar expanded"
                className={cn(RAIL_ROW, 'text-ink-3 hover:text-ink w-full cursor-pointer')}
              >
                <span className="grid size-8 shrink-0 place-items-center">
                  {pinned ? (
                    <PanelLeftClose className="size-[0.95rem]" aria-hidden />
                  ) : (
                    <PanelLeftOpen className="size-[0.95rem]" aria-hidden />
                  )}
                </span>
                <Label>{pinned ? 'Collapse' : 'Keep expanded'}</Label>
              </button>
            </li>
          </ul>
        </div>
      </nav>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} entries={searchable} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Desktop top bar. Sticky and opaque. It holds the things about the
            SESSION rather than the screen: whether the data is real, the
            time, search, open alerts, who is signed in. Below lg the clock
            and the scenario name drop out and the search narrows, so the
            row never overflows on a laptop. */}
        <header className="bg-canvas border-line sticky top-0 z-20 hidden h-14 items-center gap-4 border-b px-8 md:flex">
          {USE_MOCKS ? (
            /* Always visible while mocking. A screen of fake numbers must
               never be mistakable for a live one. */
            <span className="bg-warn/10 text-warn ring-warn/25 inline-flex items-center gap-2 rounded-md px-3 py-1 text-xs ring-1 ring-inset">
              <FlaskConical className="size-3.5" aria-hidden />
              Fixture data
              <span className="text-warn/70 hidden lg:inline">
                · scenario <span className="tabular">{MOCK_SCENARIO}</span>
              </span>
            </span>
          ) : (
            <span className="text-ok inline-flex items-center gap-2 text-xs">
              <span className="size-2 rounded-full bg-current" aria-hidden />
              Connected
            </span>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <Clock />

            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-keyshortcuts="Control+K Meta+K"
              className="border-edge bg-panel/60 text-ink-3 hover:text-ink-2 hover:border-line-strong ease-soft flex h-8 w-48 min-w-0 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors duration-200 lg:w-64"
            >
              <Search className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Search screens…</span>
              <kbd className="border-edge ml-auto shrink-0 rounded-md border px-1 py-0.5 text-[10px]">
                {SHORTCUT}
              </kbd>
            </button>

            {canReach(user?.role, ALERTS_PATH) && <AlertsBell />}

            <span className="bg-line mx-1 h-5 w-px" aria-hidden />

            <AccountMenu />
          </div>
        </header>

        {USE_MOCKS && (
          <div className="bg-warn/8 flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 md:hidden">
            <Badge tone="warn" icon={<FlaskConical className="size-3.5" aria-hidden />}>
              Fixture data
            </Badge>
            <span className="text-warn/85 text-xs">
              No backend connected · scenario <span className="tabular">{MOCK_SCENARIO}</span>
            </span>
          </div>
        )}

        {/* Always visible for an ADMIN, scoped or not (UX_AUDIT.md finding 1):
            an admin working through several screens must never lose sight of
            which branch (if any) they are looking at. */}
        {isAdmin && (
          <div className="border-accent/25 bg-accent/8 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 md:px-8">
            <Building2 className="text-accent-ink size-3.5 shrink-0" aria-hidden />
            <label htmlFor="branch-switcher" className="text-ink text-xs">
              Branch
            </label>
            <select
              id="branch-switcher"
              className={cn(controlClass(), 'h-7 max-w-56 py-0 text-xs')}
              value={scope.agencyId ?? ''}
              onChange={(e) => {
                if (e.target.value === '') {
                  scope.leave()
                  return
                }
                const agency = (agencies.data ?? []).find((a) => a.id === e.target.value)
                if (agency) scope.enter(agency)
              }}
            >
              <option value="">All branches</option>
              {(agencies.data ?? []).map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
            {scope.agencyName ? (
              <span className="text-ink-2 text-xs">
                Everything below is {scope.agencyName} only.
              </span>
            ) : (
              <span className="text-ink-2 text-xs">Looking at every branch at once.</span>
            )}
          </div>
        )}

        <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          {/* Capped, because a table stretched across an ultrawide is
              unreadable; wide, because charts and the roster want room. */}
          <div key={pathname} className="animate-fade-rise mx-auto max-w-[88rem]">
            <ScreenErrorBoundary>
              <Outlet />
            </ScreenErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}

/* Shared by every rail row so the chip column lines up exactly: 8px of rail
   padding plus 8px of row padding centres a 32px chip in the 64px rail. */
const RAIL_ROW =
  'group ease-soft flex items-center gap-3 rounded-lg px-2 py-1 text-sm font-semibold transition-colors duration-150'

/* Hours and minutes. A wall display is often the only clock in the room, and
   "how stale is this" is easier to judge with the current time beside it. */
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <time
      dateTime={now.toISOString()}
      className="text-ink-3 tabular mr-2 hidden text-sm whitespace-nowrap lg:inline"
    >
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      <span className="text-ink-3 ml-2 text-xs">
        {now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
      </span>
    </time>
  )
}

function RailLink({
  to,
  label,
  icon: Icon,
  onNavigate,
}: {
  to: string
  label: string
  icon: LucideIcon
  onNavigate: () => void
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          RAIL_ROW,
          /* Solid, not glass: a translucent selection on the rail reads as a
             smudge rather than a press. Collapsed, the fill is a ring round
             the chip; expanded, a pill. */
          isActive ? 'bg-panel-2 text-ink' : 'text-ink-2 hover:text-ink hover:bg-panel-2/60',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* The chip carries the state, so the selection is still visible
              with the labels hidden. */}
          <span
            className={cn(
              'ease-soft grid size-8 shrink-0 place-items-center transition-colors duration-150',
              isActive ? 'text-accent-ink' : 'text-ink-3 group-hover:text-ink',
            )}
          >
            <Icon className="size-[0.95rem]" aria-hidden />
          </span>
          <Label>{label}</Label>
        </>
      )}
    </NavLink>
  )
}

/* A section title on the expanded rail. Collapsed, there is no room for a
   word, so a short rule marks where the section starts instead and the two
   cross-fade. Hidden from assistive tech: the surrounding role="group" already
   carries the title as its name. */
function SectionHeading({ title }: { title: string }) {
  return (
    <div aria-hidden className="relative mt-3 mb-1 h-4 px-3 md:mx-2 md:px-2">
      <span className="bg-line-strong ease-soft absolute top-1/2 left-1/2 hidden h-px w-5 -translate-x-1/2 transition-opacity duration-200 md:block md:group-has-[:focus-visible]/rail:opacity-0 md:group-hover/rail:opacity-0 md:group-data-[pinned=true]/rail:opacity-0" />
      <Label className="text-ink-3 tracked block text-[9.5px] leading-4 font-medium">{title}</Label>
    </div>
  )
}

/* A rail label: always shown in the phone sheet, faded out on the collapsed
   desktop rail and back in while it is expanded or pinned. Faded rather than
   unmounted, so it stays the link's accessible name either way. */
function Label({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'ease-soft truncate whitespace-nowrap transition-opacity duration-200',
        'md:opacity-0 md:group-has-[:focus-visible]/rail:opacity-100 md:group-hover/rail:opacity-100 md:group-data-[pinned=true]/rail:opacity-100',
        className,
      )}
    >
      {children}
    </span>
  )
}
