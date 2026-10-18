import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Info } from 'lucide-react'
import { actionErrorMessage, fetchQueue } from '@/api/endpoints/tickets'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchServices } from '@/api/endpoints/services'
import { assignAgent, fetchAgents } from '@/api/endpoints/assignments'
import { fetchWorkstations } from '@/api/endpoints/workstations'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { controlClass } from '@/components/ui/control'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Screen } from './Screen'
import AgentQueue from './AgentQueue'
import { queueSignal, type QueueLevel } from './queueSignal'
import {
  attendanceFeedDown,
  attendanceFlag,
  freeAgents,
  occupancyFlag,
  occupancyOf,
} from './staffingChecks'

/**
 * The visitor queue - the ADMIN and MANAGER view.
 *
 * This used to be a working queue console: a waiting list, calling tickets to
 * counters, registering visitors. Removed (2026-09-05, at the user's
 * direction) - running the queue is AGENT's job now, done entirely in
 * `AgentQueue`. What's left here is oversight: say who's covering each
 * counter, and see how its line is doing.
 *
 * COUNTER-FIRST, NOT AGENT-FIRST
 *
 * This board used to list agents, each with its own "which counter" picker -
 * the counter existed only as an attribute of whichever agent happened to
 * hold it. Backwards from reality: the counter is the fixed, physical thing;
 * the person behind one rotates (breaks, shift changes, covering for someone
 * out sick). The list below is counters, each with a "who's covering this"
 * picker instead - same underlying assignment (`assignAgent`,
 * `PATCH /agents/{id}/assignment`), same data, just read the other way.
 * `backend/app/api/assignments.py` now also enforces at the database level
 * that a counter has at most one current agent (a partial unique index on
 * users.counter_id) - this screen's reverse lookup, one counter to at most
 * one agent, depends on that being true, not just usually true.
 *
 * ASSIGNMENT AND "SEEING THEIR QUEUES"
 *
 * Both real (api/endpoints/assignments.ts, backend/app/api/assignments.py,
 * contracts/api.md), reading and writing the same account-to-counter link
 * AgentQueue itself reads from - no mock in the loop except under
 * VITE_USE_MOCKS. "See their queues" is a waiting count per
 * assigned service, not who they're currently with: GET /api/tickets/queue
 * only ever returns WAITING tickets (contracts/api.md §8), and "currently
 * serving" is state AgentQueue keeps in its own browser tab - nothing a
 * manager's session could read even if this screen wanted to show it.
 * Faking a live "now serving" here would be inventing data nobody has.
 *
 * STAFFING FLAGS
 *
 * Each counter row cross-checks its assigned agent against reality with two
 * independent signals, see staffingChecks.ts: attendance (did they badge in
 * today) and occupancy (is anyone at the counter right now, from the AI
 * workstation bound to it). A flagged row shows who is badged in and free, so
 * the fix - the picker on the same row - is right there.
 *
 * QUEUE SIGNAL (Phase M): each counter's line is also measured against the
 * agency's depth and oldest-wait thresholds (queueSignal.ts) and badged
 * "Getting busy" / "Backed up". Dashboard-visual only - it never becomes an
 * alert or a push, because a long line is a service-quality problem, not a
 * safety one.
 *
 * A counter with no service assigned can't back an agent assignment either -
 * AgentQueue needs a service_id to know what queue to show - so those are
 * left out of the list rather than offered as a dead end. Assign one on the
 * branch's detail page (CountersPanel) first.
 */

/** Routes AGENT to its own screen; everyone else gets the board below. */
export default function VisitorQueue() {
  const { user } = useSession()
  if (user?.role === 'AGENT') return <AgentQueue />
  return <VisitorQueueBoard />
}

function VisitorQueueBoard() {
  const { user } = useSession()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
  })

  /* Counters live nested inside their agency and nowhere else. A MANAGER
     gets exactly one agency back, so this resolves to their own; an ADMIN
     resolves to the first, same as the rest of this screen always has. */
  const scope = useScope()
  const myAgency = useMemo(() => {
    const list = agencies.data ?? []
    // An admin gets the branch they have open; with none open, the first.
    if (isAdmin) return list.find((a) => a.id === scope.agencyId) ?? list[0] ?? null
    const mine = list.filter((a) => a.id === user?.agency_id)
    return mine[0] ?? null
  }, [agencies.data, isAdmin, scope.agencyId, user?.agency_id])

  const assignableCounters = useMemo(
    () =>
      (myAgency?.counters ?? [])
        .filter((c) => c.service_id != null)
        .sort((a, b) => a.number - b.number),
    [myAgency],
  )

  const services = useQuery({
    queryKey: ['services', myAgency?.id],
    queryFn: ({ signal }) => fetchServices(myAgency!.id, signal),
    enabled: myAgency != null,
  })

  const agents = useQuery({
    queryKey: ['agents', myAgency?.id],
    queryFn: ({ signal }) => fetchAgents(myAgency!.id, signal),
    enabled: myAgency != null,
  })

  /* Unfiltered - a waiting count per service, for every agent, needs every
     service's tickets regardless of which one any single agent is on. */
  const queue = useQuery({
    queryKey: ['tickets', 'queue', null],
    queryFn: ({ signal }) => fetchQueue(undefined, signal),
    refetchInterval: 10_000,
  })
  const waitingByService = (serviceId: string): number =>
    (queue.data ?? []).filter((t) => t.service_id === serviceId).length
  /* Re-evaluated on every render, and the queue refetches every 10s, so the
     oldest-wait figure keeps moving without its own timer. */
  const now = Date.now()
  const signalFor = (serviceId: string) =>
    myAgency
      ? queueSignal(
          (queue.data ?? []).filter((t) => t.service_id === serviceId),
          myAgency,
          now,
        )
      : { level: 'ok' as QueueLevel, reasons: [] as string[] }

  /* Occupancy, only fetched when some counter actually has a workstation
     bound. A failure here (AI service down, no access) just means no
     occupancy chips - it must never take the board down with it. */
  const hasWorkstations = (myAgency?.counters ?? []).some((c) => c.workstation_name)
  const workstations = useQuery({
    queryKey: ['workstations'],
    queryFn: ({ signal }) => fetchWorkstations(signal),
    enabled: hasWorkstations,
    refetchInterval: 10_000,
    retry: false,
  })
  const workstationByName = useMemo(
    () => new Map((workstations.data ?? []).map((w) => [w.name, w])),
    [workstations.data],
  )

  const assign = useMutation({
    mutationFn: ({ userId, counterId }: { userId: string; counterId: string | null }) =>
      assignAgent(userId, counterId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents', myAgency?.id] }),
  })
  const assignError = actionErrorMessage(assign.error)

  /* One counter maps to at most one current agent - guaranteed by the
     database now (a partial unique index on users.counter_id), not just
     usually true, so this reverse lookup is safe to treat as 0-or-1. */
  const agentOnCounter = (counterId: string) =>
    (agents.data ?? []).find((agent) => agent.assignment?.counter_id === counterId) ?? null

  /* One queue per SERVICE, shared by every counter on it: whichever counter
     calls next takes the oldest ticket. Grouped that way, a second counter
     helping on a busy service reads as help on one queue, not as a second
     queue just as full (2026-10-18 day test). */
  const serviceGroups = useMemo(() => {
    const byService = new Map<string, typeof assignableCounters>()
    for (const counter of assignableCounters) {
      const key = counter.service_id as string
      byService.set(key, [...(byService.get(key) ?? []), counter])
    }
    return [...byService.entries()].map(([serviceId, counters]) => ({ serviceId, counters }))
  }, [assignableCounters])

  const uncovered = (agents.data ?? []).filter((agent) => agent.assignment === null)
  const free = freeAgents(agents.data ?? [])
  const feedDown = attendanceFeedDown(agents.data ?? [])

  return (
    <Screen
      title="Visitor queue"
      description="Who's covering each counter, and how its line is doing."
    >
      <Panel as="section">
        <PanelHeader>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-ink text-sm font-semibold">Counters</h2>
            <span className="text-ink-3 tabular text-xs">
              {assignableCounters.length} {assignableCounters.length === 1 ? 'counter' : 'counters'}
            </span>
          </div>
        </PanelHeader>

        {assignError && (
          <div className="border-line border-b px-6 py-3">
            <p role="alert" className="text-warn text-sm">
              {assignError}
            </p>
          </div>
        )}

        <AsyncBoundary
          isPending={agents.isPending || services.isPending}
          error={agents.error ?? services.error}
          isEmpty={assignableCounters.length === 0}
          emptyMessage="No counter here has a service assigned yet - do that on the branch's detail page first."
          forbiddenMessage="Assigning agents is done by managers and administrators."
          onRetry={() => void agents.refetch()}
        >
          <PanelBody className="space-y-2">
            {feedDown && (
              <p
                role="status"
                className="text-ink-3 flex items-start gap-2 text-xs leading-relaxed"
              >
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  The badge feed is down right now, so attendance isn't being checked - a missing
                  badge-in doesn't mean anyone is absent.
                </span>
              </p>
            )}
            {serviceGroups.map((group) => {
              const serviceName =
                services.data?.find((sv) => sv.id === group.serviceId)?.name ?? 'Service'
              const queueState = signalFor(group.serviceId)
              const covered = group.counters.filter((c) => agentOnCounter(c.id) !== null).length
              return (
                <section key={group.serviceId} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2">
                    <div className="min-w-0">
                      <h3 className="text-ink truncate text-sm font-semibold">{serviceName}</h3>
                      <p className="text-ink-3 text-xs">
                        {group.counters.length === 1
                          ? '1 counter'
                          : `${group.counters.length} counters share this queue`}
                        {` · ${covered} covered`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-2 tabular text-sm font-medium">
                        {waitingByService(group.serviceId)} waiting
                      </span>
                      {queueState.level !== 'ok' && (
                        <Badge tone={queueState.level === 'critical' ? 'danger' : 'warn'}>
                          {queueState.level === 'critical' ? 'Backed up' : 'Getting busy'}
                          {` · ${queueState.reasons.join(', ')}`}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {group.counters.map((counter) => {
                    const covering = agentOnCounter(counter.id)
                    const workstation = occupancyOf(counter, workstationByName)
                    const flags = [
                      attendanceFlag(covering, counter.is_open),
                      occupancyFlag(counter, workstation),
                    ].filter((flag) => flag !== null)
                    return (
                      <div
                        key={counter.id}
                        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
                          flags.length > 0 ? 'border-warn/40 bg-warn/5' : 'border-line'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-ink truncate text-sm font-medium">
                            {counter.name ?? `Counter ${counter.number}`}
                          </p>
                          <p className="text-ink-3 mt-0.5 text-xs">
                            {covering ? covering.full_name : 'Nobody covering it'}
                          </p>
                          {workstation && (
                            <p className="mt-1">
                              <Badge
                                tone={
                                  workstation.status === 'present'
                                    ? 'ok'
                                    : workstation.status === 'away'
                                      ? 'warn'
                                      : 'neutral'
                                }
                              >
                                {workstation.status === 'present'
                                  ? 'Someone at the counter'
                                  : workstation.status === 'away'
                                    ? 'Nobody at the counter'
                                    : 'Occupancy not classified'}
                              </Badge>
                            </p>
                          )}
                          {flags.map((flag) => (
                            <p
                              key={flag.kind}
                              role="status"
                              className="text-warn mt-1 flex items-center gap-1.5 text-xs font-medium"
                            >
                              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                              {flag.text}
                            </p>
                          ))}
                          {flags.length > 0 && free.length > 0 && (
                            <p className="text-ink-3 mt-1 text-xs">
                              Badged in and free: {free.map((a) => a.full_name).join(', ')}.
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <select
                            aria-label={`Who's covering ${counter.name ?? `Counter ${counter.number}`}`}
                            className={controlClass()}
                            value={covering?.user_id ?? ''}
                            disabled={assign.isPending}
                            onChange={(e) => {
                              const userId = e.target.value
                              if (userId === '') {
                                if (covering)
                                  assign.mutate({ userId: covering.user_id, counterId: null })
                                return
                              }
                              assign.mutate({ userId, counterId: counter.id })
                            }}
                          >
                            <option value="">Nobody</option>
                            {(agents.data ?? []).map((agent) => {
                              /* Picking an agent already on another counter moves
                               them here - the assignment endpoint relieves their
                               previous post automatically,
                               so every agent is a valid choice, not just the free
                               ones. The suffix is what makes that move visible
                               before it happens rather than after. */
                              const elsewhere =
                                agent.assignment && agent.assignment.counter_id !== counter.id
                                  ? agent.assignment.counter_name
                                  : null
                              return (
                                <option key={agent.user_id} value={agent.user_id}>
                                  {agent.full_name}
                                  {agent.role === 'MANAGER' ? ' (manager)' : ''}
                                  {elsewhere ? ` (currently ${elsewhere})` : ''}
                                </option>
                              )
                            })}
                          </select>
                        </div>
                      </div>
                    )
                  })}
                </section>
              )
            })}
          </PanelBody>
        </AsyncBoundary>
      </Panel>

      {uncovered.length > 0 && (
        <p className="text-ink-3 mt-4 text-xs leading-relaxed">
          Not covering a counter right now: {uncovered.map((a) => a.full_name).join(', ')}.
        </p>
      )}

      <p className="text-ink-3 mt-2 flex items-start gap-2 text-xs leading-relaxed">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Waiting counts refresh every 10 seconds. They don't show who an agent is currently with -
          that's tracked only in the agent's own browser tab, nowhere this screen can read it from.
        </span>
      </p>
    </Screen>
  )
}
