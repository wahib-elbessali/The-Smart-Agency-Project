import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { fetchVisitorHistory } from '@/api/endpoints/tickets'
import { Clock } from '@/components/ui/Time'

/**
 * "This person has been here before" for the agent at the counter. Every
 * kiosk visit is a new anonymous visitor; the face captured at the kiosk is
 * what ties visits together (GET /api/tickets/{id}/history). Shows nothing
 * for a first visit, or when no face was captured - neither is news the
 * agent needs to act on.
 */
export function ReturningVisitorCard({ ticketId }: { ticketId: string }) {
  const history = useQuery({
    queryKey: ['ticketHistory', ticketId],
    queryFn: ({ signal }) => fetchVisitorHistory(ticketId, signal),
    retry: false,
  })
  const visits = history.data?.previous_visits ?? []
  if (visits.length === 0) return null

  return (
    <div className="border-info/30 bg-info/8 w-full max-w-sm rounded-lg border p-3 text-left">
      <p className="text-ink flex items-center gap-2 text-sm font-medium">
        <History className="size-4 shrink-0" aria-hidden />
        Returning visitor -{' '}
        {visits.length === 1 ? '1 earlier visit' : `${visits.length} earlier visits`}
      </p>
      <ul className="mt-2 space-y-1.5">
        {visits.map((visit) => (
          <li key={visit.ticket_number} className="text-ink-2 text-xs">
            <span className="text-ink">
              <Clock iso={visit.created_at} />
            </span>{' '}
            · {visit.service_name ?? 'Unknown service'} ·{' '}
            {visit.status.toLowerCase().replace('_', ' ')}
            {visit.notes && <span className="text-ink-3 block italic">“{visit.notes}”</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
