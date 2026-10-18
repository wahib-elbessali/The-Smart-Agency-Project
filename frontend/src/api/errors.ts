/**
 * One error type for the whole API layer, so screens can branch on `kind`
 * instead of string-matching messages.
 *
 * `message` is written to be shown to a person: playbook 9 asks errors to say
 * what happened and what to do, not to leak a stack trace onto a wall display.
 */
export type ApiErrorKind =
  | 'network' // request never reached the backend
  | 'timeout' // backend took longer than REQUEST_TIMEOUT_MS
  | 'http' // backend answered with a non-2xx status
  | 'parse' // backend answered, body was not the JSON we expected
  | 'not_implemented' // no fixture / endpoint module exists yet

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  /** Per-problem messages when the backend sent a `detail.errors` list (a
   *  rejected AI config change lists every bad value), otherwise empty. */
  readonly errors: readonly string[]

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    errors: readonly string[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.errors = errors
  }
}

/** True when the server understood the request and refused it on permissions. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 403
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new ApiError('timeout', 'The server took too long to answer.')
  }
  return new ApiError('network', 'Could not reach the server.')
}

/** Short, human sentence for a screen to show. Never the raw message. */
export function describeApiError(error: ApiError): string {
  switch (error.kind) {
    case 'network':
      return 'Could not reach the server. Check that the backend is running.'
    case 'timeout':
      return 'The server took too long to answer. It may be under load.'
    case 'http':
      /* 401 and 403 are the two a person can act on, and they need opposite
         advice: one means sign in again, the other means signing in again
         will not help. Everything else is a server problem, not theirs. */
      if (error.status === 401) {
        return 'Your session has ended. Sign in again to continue.'
      }
      if (error.status === 403) {
        return 'Your role does not have access to this.'
      }
      return `The server rejected the request (${error.status ?? 'unknown status'}).`
    case 'parse':
      return 'The server sent something this screen could not read.'
    case 'not_implemented':
      return error.message
  }
}
