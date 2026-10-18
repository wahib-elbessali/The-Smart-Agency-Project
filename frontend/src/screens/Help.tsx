import { Link } from 'react-router'
import { ChevronRight, FlaskConical } from 'lucide-react'
import { USE_MOCKS } from '@/api/config'
import { useSession } from '@/auth/SessionContext'
import { canReach } from '@/auth/access'
import { SCREEN_SECTIONS, SCREENS } from '@/auth/screens'
import { Badge } from '@/components/ui/Badge'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Screen } from './Screen'

/**
 * Help: a map of the application for the person reading it.
 *
 * Built from SCREENS and the same role filter the rail uses, so it can only
 * describe screens this person can open and cannot go stale when one is added
 * - a hand-written help page would be the first thing to drift. Sectioned the
 * same way as the sidebar, so the two read as one map.
 */
export default function Help() {
  const { user } = useSession()
  const reachable = SCREENS.filter(({ to }) => canReach(user?.role, to))

  return (
    <Screen title="Help" description="What each screen is for, and where to find it.">
      <div className="flex max-w-3xl flex-col gap-6">
        {USE_MOCKS && (
          <Panel tone="alert" className="flex flex-wrap items-center gap-3 p-4">
            <Badge tone="warn" icon={<FlaskConical className="size-3.5" aria-hidden />}>
              Fixture data
            </Badge>
            <span className="text-ink-2 text-xs">
              No backend is connected, so every number you see is sample data.
            </span>
          </Panel>
        )}

        {SCREEN_SECTIONS.map(({ group, title }) => (
          <Guide
            key={group}
            title={title}
            screens={reachable.filter((entry) => entry.group === group)}
          />
        ))}

        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Using the sidebar</h2>
          </PanelHeader>
          <PanelBody>
            <ul className="text-ink-2 flex list-disc flex-col gap-2 pl-4 text-[0.8125rem]">
              <li>Hover the sidebar, or tab into it, to see the screen names.</li>
              <li>
                Alerts open from the bell at the top right, which also shows how many are still
                open.
              </li>
              <li>Press Ctrl+K (⌘K on a Mac) anywhere to jump to a screen by typing its name.</li>
              <li>The button at the bottom keeps it expanded; Settings has the same switch.</li>
              <li>Your role decides which screens appear. Missing one? Ask an administrator.</li>
            </ul>
          </PanelBody>
        </Panel>
      </div>
    </Screen>
  )
}

function Guide({ title, screens }: { title: string; screens: typeof SCREENS }) {
  if (screens.length === 0) return null
  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">{title}</h2>
      </PanelHeader>
      <PanelBody className="pt-2">
        <ul className="divide-line divide-y">
          {screens.map(({ to, label, description, icon: Icon }) => (
            <li key={to}>
              <Link to={to} className="group flex items-center gap-3 py-3">
                <span className="bg-panel-2 text-ink-2 group-hover:text-ink grid size-8 shrink-0 place-items-center rounded-full">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="text-ink w-40 shrink-0 text-sm">{label}</span>
                <span className="text-ink-2 min-w-0 flex-1 text-xs">{description}</span>
                <ChevronRight
                  className="text-ink-3 group-hover:text-ink size-4 shrink-0"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  )
}
