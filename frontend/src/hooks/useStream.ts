import { useEffect, useRef, useState } from 'react'
import type { SocketStream, StreamStatus } from '@/api/socketStream'

/**
 * Subscribes to a socket stream and folds its frames into state.
 *
 * The factory and the reducer are held in refs so that passing inline
 * functions - which every caller does - does not tear the socket down and
 * rebuild it on every render. That mistake reconnects in a loop and stays
 * invisible until someone watches the network tab.
 *
 * `key` is the only thing that rebuilds the stream. It is a string rather than
 * a dependency array so the effect's dependencies are literal and checkable:
 * the alerts screen passes the chosen feature, and a screen with one fixed
 * feed passes a constant.
 */
export function useStream<TFrame, TState>(
  key: string,
  create: () => SocketStream<TFrame>,
  reduce: (current: TState, frame: TFrame) => TState,
  initial: () => TState,
): { state: TState; status: StreamStatus } {
  const [state, setState] = useState<TState>(initial)
  const [status, setStatus] = useState<StreamStatus>('idle')

  const reduceRef = useRef(reduce)
  reduceRef.current = reduce
  const createRef = useRef(create)
  createRef.current = create
  const initialRef = useRef(initial)
  initialRef.current = initial

  useEffect(() => {
    /* Reset on rebuild: frames from the previous stream describe a different
       feed, and carrying them over would blend two sources into one panel. */
    setState(initialRef.current())

    const stream = createRef.current()
    const stopEvents = stream.subscribe((frame) => {
      setState((current) => reduceRef.current(current, frame))
    })
    const stopStatus = stream.onStatusChange(setStatus)

    return () => {
      stopEvents()
      stopStatus()
      stream.close()
    }
  }, [key])

  return { state, status }
}
