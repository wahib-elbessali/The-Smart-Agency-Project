import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Clock as ClockIcon } from 'lucide-react'
import { fetchMyAssignment } from '@/api/endpoints/assignments'
import {
  actionErrorMessage,
  callTicket,
  completeTicket,
  fetchQueue,
  skipTicket,
  startService,
} from '@/api/endpoints/tickets'
import type { Ticket } from '@/api/types'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Clock } from '@/components/ui/Time'
import { ReturningVisitorCard } from './ReturningVisitorCard'
import { Screen } from './Screen'

/**
 * The AGENT's queue: one ticket at a time, a place to note how it went, and a
 * button to move on.
 *
 * Everything VisitorQueueBoard shows an ADMIN or MANAGER - the full waiting
 * list, every counter, visitor registration - is deliberately absent. An
 * agent at a desk needs to know who they're with and who's next, not run a
 * management console.
 *
 * WHO ASSIGNS THE SERVICE
 *
 * This used to ask the agent to pick their own service and counter. Changed
 * (2026-09-05): which service an agent works is a MANAGER's call, not the
 * agent's, so this reads it from GET /api/agents/me/assignment instead of
 * showing a picker. Built ahead of the backend at the time (nothing stored an
 * agent-to-counter link yet), no longer the case - backend/app/api/assignments.py
 * is real now and documented (contracts/api.md, GET /api/agents/me/assignment),
 * and this screen calls it directly, no mock in the loop except under
 * VITE_USE_MOCKS. See api/endpoints/assignments.ts. An agent nobody has
 * assigned sees an honest empty state, not a picker.
 *
 * "Currently serving" has the same limitation as the board's at-counter
 * panel: GET /api/tickets/queue returns WAITING tickets only, so the one just
 * called has to be remembered locally rather than read back from the server.
 *
 * NOTES
 *
 * `notes` on complete used to be sent into a route that ignored it. It
 * doesn't anymore - backend/app/api/tickets.py's complete route takes an
 * optional `notes` body now (contracts/api.md §8 already documents it).
 *
 * START SERVICE / SKIP (scenario-planning backlog, Phase A)
 *
 * While `current.status === 'CALLED'`, two extra actions appear alongside
 * Next: "Start service" (marks the moment the visitor actually arrived -
 * manual, always the agent's call, never auto-detected) and "Skip
 * (no-show)" (also always manual, but gated by a visible countdown derived
 * from the agency's own `no_show_min_wait_seconds` - the button itself is
 * disabled until it elapses, same way the backend's 409 backstops it).
 * Pressing "Start service" just flips `current` to IN_SERVICE locally
 * (from the route's response) and both buttons disappear - "Next" still
 * works the same either way, since `complete_ticket` already accepts both
 * CALLED and IN_SERVICE.
 */

const POLL_MS = 10_000

export default function AgentQueue() {
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState<Ticket | null>(null)
  const [note, setNote] = useState('')

  const assignment = useQuery({
    queryKey: ['myAssignment'],
    queryFn: ({ signal }) => fetchMyAssignment(signal),
  })

  const assigned = assignment.data ?? null
  const serviceId = assigned?.service_id ?? null
  const counterId = assigned?.counter_id ?? null

  const queue = useQuery({
    queryKey: ['tickets', 'queue', serviceId],
    queryFn: ({ signal }) => fetchQueue(serviceId ?? undefined, signal),
    enabled: serviceId != null,
    refetchInterval: POLL_MS,
  })

  const waiting = queue.data ?? []
  const next = waiting[0] ?? null

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tickets', 'queue'] })

  /* Shared by "Next" (complete-then-call) and "Skip" (skip-then-call) - both
   * end the same way: whoever's waiting longest gets called next.
   *
   * Re-fetched here rather than read from `next` above: the render scope's
   * `waiting` can be a poll interval stale, and pressing a button twice in
   * quick succession - exactly how this is meant to be used - would
   * otherwise call the same ticket id twice and earn a 409 on the second
   * press, before the first press's own refetch had a chance to land.
   */
  const callNextWaiting = async (): Promise<Ticket | null> => {
    const fresh = await queryClient.fetchQuery({
      queryKey: ['tickets', 'queue', serviceId],
      queryFn: ({ signal }) => fetchQueue(serviceId ?? undefined, signal),
    })
    const upNext = fresh[0] ?? null
    return upNext ? callTicket(upNext.id, counterId!) : null
  }

  const advance = useMutation({
    /* Complete whoever is current (if anyone), then call whoever is next. */
    mutationFn: async () => {
      if (current) await completeTicket(current.id, note.trim() || undefined)
      return callNextWaiting()
    },
    onSuccess: (ticket) => {
      setCurrent(ticket)
      setNote('')
      void refresh()
    },
    onError: () => {
      setCurrent(null)
      setNote('')
      void refresh()
    },
  })

  const startServiceMutation = useMutation({
    mutationFn: () => startService(current!.id),
    onSuccess: (ticket) => setCurrent(ticket),
  })

  const skipMutation = useMutation({
    /* Always a human decision - see the module comment. No timer or tracking
     * triggers this on its own; it only runs when the button is pressed, and
     * the button itself stays disabled until minWaitSeconds has elapsed. */
    mutationFn: async () => {
      await skipTicket(current!.id)
      return callNextWaiting()
    },
    onSuccess: (ticket) => {
      setCurrent(ticket)
      setNote('')
      void refresh()
    },
    onError: () => {
      setCurrent(null)
      setNote('')
      void refresh()
    },
  })

  const minWaitSeconds = assigned?.no_show_min_wait_seconds ?? 60

  /* Only ticks while it matters - a ticking interval for a screen nobody's
   * waiting on a decision in would just be wasted renders. */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!current || current.status !== 'CALLED') return
    const id = setInterval(() => setTick((t) => t + 1), 1_000)
    return () => clearInterval(id)
  }, [current])

  const awaitingArrival = current != null && current.status === 'CALLED'
  const elapsedSeconds =
    awaitingArrival && current.called_at
      ? Math.max(0, Math.floor((Date.now() - new Date(current.called_at).getTime()) / 1000))
      : 0
  const remainingSeconds = Math.max(0, minWaitSeconds - elapsedSeconds)
  const canSkip = awaitingArrival && remainingSeconds === 0
  const skipCountdown = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(
    remainingSeconds % 60,
  ).padStart(2, '0')}`

  const errorMessage = actionErrorMessage(
    advance.error ?? startServiceMutation.error ?? skipMutation.error,
  )

  return (
    <Screen
      title={assigned?.service_name ?? 'Visitor queue'}
      description="Who you're with, and who's next."
    >
      <AsyncBoundary
        isPending={assignment.isPending}
        error={assignment.error}
        isEmpty={assigned == null}
        emptyMessage="Your manager hasn't put you on a counter yet. Ask them to assign you to a service."
        forbiddenMessage="Assignments are read by the signed-in agent only."
        onRetry={() => void assignment.refetch()}
      >
        <Panel as="section">
          <PanelBody className="flex flex-col items-center gap-6 py-12 text-center">
            <div>
              <p className="text-ink-3 text-xs font-semibold tracking-wide uppercase">
                Now serving
              </p>
              {current ? (
                <>
                  <p className="text-ink mt-2 font-mono text-4xl font-medium">
                    {current.ticket_number}
                  </p>
                  <p className="text-ink-2 mt-1 text-lg">{current.visitor_name}</p>
                </>
              ) : (
                <p className="text-ink-2 mt-2 text-lg">Nobody yet</p>
              )}
            </div>

            {current && <ReturningVisitorCard ticketId={current.id} />}

            {current && (
              <div className="w-full max-w-sm text-left">
                <Field
                  id="notes"
                  label="Notes"
                  hint="Optional. Saved when you move to the next person."
                >
                  {(props) => (
                    <textarea
                      {...props}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="How did it go?"
                      rows={3}
                    />
                  )}
                </Field>
              </div>
            )}

            {awaitingArrival && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  disabled={startServiceMutation.isPending}
                  onClick={() => startServiceMutation.mutate()}
                >
                  Start service
                </Button>
                <Button
                  disabled={!canSkip || skipMutation.isPending}
                  onClick={() => skipMutation.mutate()}
                >
                  <ClockIcon className="size-3.5" aria-hidden />
                  {canSkip ? 'Skip (no-show)' : `Skip in ${skipCountdown}`}
                </Button>
              </div>
            )}

            {errorMessage && (
              <p role="alert" className="text-warn text-sm">
                {errorMessage}
              </p>
            )}

            <Button
              variant="primary"
              disabled={(!current && !next) || advance.isPending}
              onClick={() => advance.mutate()}
            >
              Next
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </PanelBody>
        </Panel>

        {/* Read-only on purpose - this is visibility, not a second way to work
            the queue. Only Next moves the line; jumping ahead from here would
            give an agent a control the board's Call button already owns. */}
        <Panel as="section" className="mt-4">
          <PanelHeader>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-ink text-sm font-semibold">Behind them</h2>
              <span className="text-ink-3 tabular text-xs">
                {waiting.length} {waiting.length === 1 ? 'person' : 'people'}
              </span>
            </div>
          </PanelHeader>
          <AsyncBoundary
            isPending={queue.isPending}
            error={queue.error}
            isEmpty={waiting.length === 0}
            emptyMessage="Nobody else is waiting for this service."
            onRetry={() => void queue.refetch()}
          >
            <PanelBody className="space-y-2">
              {waiting.map((ticket, index) => (
                <div
                  key={ticket.id}
                  className="border-line flex items-center gap-3 rounded-lg border px-4 py-3"
                >
                  <span className="text-ink-3 tabular w-5 shrink-0 text-sm">{index + 1}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink font-mono text-[0.8125rem] font-medium">
                        {ticket.ticket_number}
                      </span>
                      <span className="text-ink truncate text-sm">{ticket.visitor_name}</span>
                    </div>
                    <p className="text-ink-3 mt-0.5 text-xs">
                      Arrived <Clock iso={ticket.created_at} />
                    </p>
                  </div>
                </div>
              ))}
            </PanelBody>
          </AsyncBoundary>
        </Panel>
      </AsyncBoundary>
    </Screen>
  )
}
