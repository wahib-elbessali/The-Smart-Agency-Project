import { Wifi, WifiOff } from 'lucide-react'
import type { StreamStatus } from '@/api/attendanceStream'
import { Badge, type Tone } from '@/components/ui/Badge'

/** Colour never carries the status alone - there is an icon and a word too. */
const PRESENTATION: Record<StreamStatus, { label: string; tone: Tone; live: boolean }> = {
  idle: { label: 'Not started', tone: 'neutral', live: false },
  connecting: { label: 'Connecting…', tone: 'info', live: false },
  open: { label: 'Live', tone: 'ok', live: true },
  reconnecting: { label: 'Reconnecting…', tone: 'warn', live: false },
  closed: { label: 'Not connected', tone: 'warn', live: false },
}

export function StreamStatusBadge({ status }: { status: StreamStatus }) {
  const { label, tone, live } = PRESENTATION[status]
  const Icon = live ? Wifi : WifiOff

  return (
    <span role="status" aria-live="polite">
      <Badge tone={tone} icon={<Icon className="size-3.5" aria-hidden />}>
        {label}
      </Badge>
    </span>
  )
}
