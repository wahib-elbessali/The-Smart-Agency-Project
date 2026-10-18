import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AsyncBoundary } from './AsyncBoundary'
import { ApiError } from '@/api/errors'

/**
 * These three states are the ones that ship broken. Worth pinning down before
 * six screens depend on them.
 */
describe('AsyncBoundary', () => {
  it('announces loading without rendering children', () => {
    render(
      <AsyncBoundary isPending error={null}>
        <p>the data</p>
      </AsyncBoundary>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.queryByText('the data')).not.toBeInTheDocument()
  })

  it('shows a human sentence for an ApiError, not the raw message', () => {
    render(
      <AsyncBoundary
        isPending={false}
        error={new ApiError('timeout', 'AbortError: signal timed out')}
      >
        <p>the data</p>
      </AsyncBoundary>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('took too long')
    expect(screen.queryByText(/AbortError/)).not.toBeInTheDocument()
  })

  it('calls onRetry when the retry button is used', async () => {
    const onRetry = vi.fn()
    render(
      <AsyncBoundary isPending={false} error={new ApiError('network', 'nope')} onRetry={onRetry}>
        <p>the data</p>
      </AsyncBoundary>,
    )

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('treats empty as a real answer, distinct from an error', () => {
    render(
      <AsyncBoundary isPending={false} error={null} isEmpty emptyMessage="No visitors waiting">
        <p>the data</p>
      </AsyncBoundary>,
    )

    expect(screen.getByText('No visitors waiting')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders children once loaded and non-empty', () => {
    render(
      <AsyncBoundary isPending={false} error={null}>
        <p>the data</p>
      </AsyncBoundary>,
    )

    expect(screen.getByText('the data')).toBeInTheDocument()
  })
})

describe('a permissions refusal', () => {
  const forbidden = new ApiError('http', 'Request failed.', 403)

  /* The request succeeded and the answer was no. Dressing that as a failure
     with a retry button invites someone to press it forever. */
  it('reads as a refusal, not a failure, and offers no retry', () => {
    const onRetry = vi.fn()
    render(
      <AsyncBoundary isPending={false} error={forbidden} onRetry={onRetry}>
        <p>secret</p>
      </AsyncBoundary>,
    )

    expect(screen.getByText(/not available to your role/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('uses the screen-specific wording when given one', () => {
    render(
      <AsyncBoundary
        isPending={false}
        error={forbidden}
        forbiddenMessage="Attendance is visible to administrators, managers and security staff."
      >
        <p>secret</p>
      </AsyncBoundary>,
    )
    expect(screen.getByText(/administrators, managers and security staff/i)).toBeInTheDocument()
  })

  /* A 401 is the opposite advice - signing in again does help. */
  it('still treats a 401 as a normal error with a retry', () => {
    render(
      <AsyncBoundary
        isPending={false}
        error={new ApiError('http', 'Request failed.', 401)}
        onRetry={() => {}}
      >
        <p>secret</p>
      </AsyncBoundary>,
    )
    expect(screen.getByText(/session has ended/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})
