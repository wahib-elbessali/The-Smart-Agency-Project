import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { PushPanel } from './PushPanel'

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PushPanel />
    </QueryClientProvider>,
  )
}

describe('PushPanel', () => {
  /* jsdom has no PushManager, which is also what an unsupported browser
     looks like - the panel must say so rather than offer a dead button. */
  it('explains when the browser cannot do push, with no enable button', () => {
    renderPanel()
    expect(screen.getByText('Critical alert notifications')).toBeInTheDocument()
    expect(screen.getByText(/cannot receive push notifications here/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable alerts/i })).not.toBeInTheDocument()
  })
})
