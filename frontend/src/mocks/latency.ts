import { MOCK_LATENCY_MS } from '@/api/config'

/**
 * Fake network delay for mocked responses, cancellable so that a component
 * unmounting mid-"request" behaves the same as it will against a real backend.
 */
export function mockDelay(signal?: AbortSignal): Promise<void> {
  const { min, max } = MOCK_LATENCY_MS
  const ms = min + Math.random() * (max - min)

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
