import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createAttendanceStream, type StreamStatus } from '@/api/attendanceStream'
import { fetchAttendanceToday } from '@/api/endpoints/attendance'
import {
  entryFromEvent,
  entryFromRecord,
  isAttendanceUpdate,
  sortEntries,
  totalsOf,
  upsertEntry,
  type AttendanceEntry,
  type PresenceTotals,
} from '@/api/attendanceMerge'

/**
 * Today's attendance: one REST snapshot, then live updates folded into it.
 *
 * Why both, rather than just the socket: a socket only tells you what happened
 * while you were listening. Someone who badged in an hour before the dashboard
 * was opened has no frame coming, so a socket-only screen would show an empty
 * building. The snapshot is the state, the socket is the delta.
 *
 * Why the merge is not `[...records, ...events]`: see attendanceMerge.ts. The
 * socket frames have no `id`, so duplicates and replays have to be folded on a
 * composite key.
 */
export interface AttendanceToday {
  entries: AttendanceEntry[]
  totals: PresenceTotals
  streamStatus: StreamStatus
  /** True when the snapshot loaded but the live feed is not running. */
  isStale: boolean
  lastEventAt: Date | null
  isPending: boolean
  error: unknown
  refetch: () => void
}

export function useAttendanceToday(): AttendanceToday {
  const query = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: ({ signal }) => fetchAttendanceToday(signal),
  })

  const [liveEntries, setLiveEntries] = useState<AttendanceEntry[]>([])
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null)

  /* The snapshot is the base every live event folds onto. Held in a ref so that
     a refetch replaces the base without discarding events that arrived since. */
  const snapshotRef = useRef<AttendanceEntry[]>([])

  useEffect(() => {
    const stream = createAttendanceStream()

    const unsubscribeStatus = stream.onStatusChange(setStreamStatus)
    const unsubscribeEvents = stream.subscribe((event) => {
      if (!isAttendanceUpdate(event)) return
      setLiveEntries((current) => upsertEntry(current, entryFromEvent(event)))
      setLastEventAt(new Date())
    })

    return () => {
      unsubscribeEvents()
      unsubscribeStatus()
      stream.close()
    }
  }, [])

  const records = query.data
  const entries = useMemo(() => {
    const base = (records ?? []).map(entryFromRecord)
    snapshotRef.current = base
    const merged = liveEntries.reduce(upsertEntry, base)
    return sortEntries(merged)
  }, [records, liveEntries])

  const totals = useMemo(() => totalsOf(entries), [entries])

  return {
    entries,
    totals,
    streamStatus,
    /* "Loaded, but not live" is the state that matters most here: a list that
       stopped updating looks identical to a quiet building. */
    isStale: !query.isPending && !query.error && streamStatus !== 'open',
    lastEventAt,
    isPending: query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}
