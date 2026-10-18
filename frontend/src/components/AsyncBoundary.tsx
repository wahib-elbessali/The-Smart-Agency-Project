import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, Lock } from 'lucide-react'
import { ApiError, describeApiError, isForbidden } from '@/api/errors'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody } from '@/components/ui/Panel'
import { SkeletonRows } from '@/components/ui/Skeleton'

/**
 * Loading / empty / error, in one place.
 *
 * Hand-rolling these six times is where the bugs live, and empty-state and
 * error-state bugs are most of what shows up on integration day. Empty is a
 * real answer here and is styled like one - it must not read as a failure.
 */

interface AsyncBoundaryProps {
  isPending: boolean
  error: unknown
  /** True when the request succeeded but there is nothing to show. */
  isEmpty?: boolean
  /** What "nothing" means here, e.g. "No visitors waiting". */
  emptyMessage?: string
  /** Screen-specific wording for a 403, naming the roles that do have access. */
  forbiddenMessage?: string
  onRetry?: () => void
  /** Skeleton line count, tuned to the content it stands in for. */
  skeletonRows?: number
  children: ReactNode
}

export function AsyncBoundary({
  isPending,
  error,
  isEmpty = false,
  emptyMessage = 'Nothing to show.',
  forbiddenMessage,
  onRetry,
  skeletonRows = 4,
  children,
}: AsyncBoundaryProps) {
  if (isPending) {
    return (
      <Panel>
        <PanelBody>
          <span className="sr-only" role="status" aria-live="polite">
            Loading
          </span>
          <SkeletonRows rows={skeletonRows} />
        </PanelBody>
      </Panel>
    )
  }

  /* A permissions refusal is not a failure, and must not be dressed as one.
     The request worked; the answer was no. Showing "Could not load this panel"
     with a Try again button invites someone to keep pressing a button that
     cannot ever succeed, and hides the real reason - that their role does not
     cover this screen. Several endpoints here are role-scoped, so this is a
     state people will actually reach, not a theoretical one. */
  if (isForbidden(error)) {
    return (
      <Panel>
        <PanelBody className="flex gap-4 py-6">
          <Lock className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div role="status">
            <h2 className="text-ink text-sm font-semibold">Not available to your role</h2>
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              {forbiddenMessage ?? 'Your role does not have access to this.'}
            </p>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  if (error) {
    const message =
      error instanceof ApiError ? describeApiError(error) : 'Something went wrong loading this.'

    return (
      <Panel tone="alert">
        <PanelBody className="py-6">
          <div className="flex gap-4">
            <AlertTriangle className="text-warn mt-0.5 size-5 shrink-0" aria-hidden />
            <div role="alert">
              <h2 className="text-warn text-sm font-semibold">Could not load this panel</h2>
              <p className="text-warn/85 mt-2 text-sm leading-relaxed">{message}</p>
              {onRetry && (
                <Button size="sm" onClick={onRetry} className="mt-4">
                  Try again
                </Button>
              )}
            </div>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  if (isEmpty) {
    return (
      <Panel>
        <PanelBody className="flex flex-col items-center gap-3 py-12 text-center">
          <Inbox className="text-ink-3 size-6" aria-hidden />
          <p className="text-ink-2 text-sm">{emptyMessage}</p>
        </PanelBody>
      </Panel>
    )
  }

  return <>{children}</>
}
