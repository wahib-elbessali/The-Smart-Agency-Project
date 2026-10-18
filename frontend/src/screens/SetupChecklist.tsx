import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { CheckCircle2, ChevronDown, ChevronUp, Circle, CircleHelp, ListChecks } from 'lucide-react'
import { fetchSetupStatus } from '@/api/endpoints/setupStatus'
import type { SetupItem } from '@/api/types'
import { useSession } from '@/auth/SessionContext'
import { canReach } from '@/auth/access'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { groupSetupItems, isExpanded, progressPercent, summaryLine } from './setupProgress'

/**
 * What this branch still needs before it is fully set up (scenario-planning
 * backlog, "New branch, day one"). A new branch depends on a long chain of
 * configuration in an order the code actually requires, and nothing used to
 * show what was missing.
 *
 * Every row is derived live on the server from data that already exists - no
 * "setup progress" flag is stored, so it cannot drift from reality. It is
 * passive and blocks nothing: the steps can be done in any order, and a branch
 * can go live half-configured if that is genuinely fine. It opens by itself
 * while there is work left and tucks itself away once everything is done.
 *
 * "Could not check" is its own state. Three steps ask the AI service, and
 * telling a manager their calibration is undone because that service was
 * restarting would be a false instruction.
 */

const STATUS_ICON = {
  done: <CheckCircle2 className="text-ok size-4 shrink-0" aria-label="Done" />,
  todo: <Circle className="text-ink-3 size-4 shrink-0" aria-label="Not done yet" />,
  unknown: <CircleHelp className="text-ink-3 size-4 shrink-0" aria-label="Could not check" />,
} as const

function Row({ item, role }: { item: SetupItem; role: string | undefined }) {
  const reachable = item.link !== null && canReach(role as never, item.link)
  const label =
    reachable && item.link ? (
      <Link
        to={item.link}
        className="text-ink hover:text-accent text-sm font-medium underline-offset-2 hover:underline"
      >
        {item.label}
      </Link>
    ) : (
      <span className="text-ink text-sm font-medium">{item.label}</span>
    )
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">{STATUS_ICON[item.status]}</span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2">
          {label}
          {item.link === null && item.status !== 'done' && (
            <span className="text-ink-3 text-xs">in the Counters panel below</span>
          )}
          {item.link !== null && !reachable && item.status !== 'done' && (
            <span className="text-ink-3 text-xs">ask an administrator</span>
          )}
        </p>
        <p className="text-ink-3 text-xs leading-relaxed">
          {item.detail}
          {item.status === 'todo' && ` - ${item.why}`}
        </p>
      </div>
    </li>
  )
}

export function SetupChecklist({ agencyId }: { agencyId: string }) {
  const { user } = useSession()
  /* Fresh on every visit: a manager does a step on another screen and comes
     back expecting to see it ticked. */
  const status = useQuery({
    queryKey: ['setup-status', agencyId],
    queryFn: ({ signal }) => fetchSetupStatus(agencyId, signal),
    staleTime: 0,
  })
  const [choice, setChoice] = useState<boolean | null>(null)

  /* A checklist that cannot load is not worth an error panel on a page whose
     real job is something else; it simply is not shown. */
  if (!status.data) return null
  const { items, done, total, complete } = status.data
  const unknown = items.filter((item) => item.status === 'unknown').length
  const expanded = isExpanded(complete, choice)

  return (
    <Panel as="section" aria-label="Branch setup">
      <PanelHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <ListChecks className="text-ink-3 size-4 shrink-0" aria-hidden />
            <h2 className="text-ink text-sm font-semibold">Branch setup</h2>
            <Badge tone={complete ? 'ok' : 'neutral'}>
              {done} of {total}
            </Badge>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setChoice(!expanded)}>
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" aria-hidden /> Hide
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" aria-hidden /> Show
              </>
            )}
          </Button>
        </div>
        <div className="bg-line mt-2 h-1.5 overflow-hidden rounded" aria-hidden>
          <div className="bg-ok h-1.5" style={{ width: `${progressPercent(done, total)}%` }} />
        </div>
        <p className="text-ink-3 mt-1.5 text-xs">{summaryLine(done, total, unknown)}</p>
      </PanelHeader>
      {expanded && (
        <PanelBody className="space-y-3">
          {groupSetupItems(items).map((group) => (
            <div key={group.name}>
              <h3 className="text-ink-3 tracked text-[10px] font-medium">
                {group.name} · {group.done}/{group.items.length}
              </h3>
              <ul>
                {group.items.map((item) => (
                  <Row key={item.key} item={item} role={user?.role} />
                ))}
              </ul>
            </div>
          ))}
          <p className="text-ink-3 border-line border-t pt-2 text-xs leading-relaxed">
            Informational only - nothing here stops a branch from going live, and the steps can be
            done in any order.
          </p>
        </PanelBody>
      )}
    </Panel>
  )
}
