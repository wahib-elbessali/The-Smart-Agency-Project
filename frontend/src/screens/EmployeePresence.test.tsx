import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import EmployeePresence from './EmployeePresence'
import { ScopeProvider } from '@/agency/scope'
import '@/mocks'

/**
 * Renders the screen against the fixture layer, which is the closest thing to
 * an integration test available while there is no backend to point at.
 */
function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      {/* No session here on purpose - these tests are about the attendance
          snapshot, not about who is reading it. ScopeProvider answers "nobody
          is inside a branch" for a signed-out tree, so the screen sees every
          row, which is what every assertion below counts. */}
      <ScopeProvider>
        <MemoryRouter>
          <EmployeePresence />
        </MemoryRouter>
      </ScopeProvider>
    </QueryClientProvider>,
  )
}

describe('EmployeePresence', () => {
  it('shows a loading state before the snapshot arrives', () => {
    renderScreen()
    /* AsyncBoundary announces this in a visually-hidden live region, so the
       skeleton is not the only thing a screen reader gets. */
    expect(screen.getByText('Loading')).toBeInTheDocument()
  })

  it('renders the roster once attendance loads', async () => {
    renderScreen()

    expect(await screen.findByRole('table', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('Hamza Benali')).toBeInTheDocument()
  })

  it('joins the employee list onto attendance to show a position', async () => {
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 3000 })

    await waitFor(() => {
      expect(screen.getAllByText("Agent d'accueil").length).toBeGreaterThan(0)
    })
  })

  /* EmployeeResponse marks position optional. A known employee with no position
     must not render the string "null" into the cell. */
  it('says so when a known employee has no position set', async () => {
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 3000 })

    await waitFor(() => {
      expect(screen.getByText('No position set')).toBeInTheDocument()
    })
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })

  /* The property that matters most on this screen: when the feed is not live,
     it has to say so rather than showing a still list that looks current. */
  it('warns that rows are not live until the stream opens', async () => {
    renderScreen()
    await screen.findByRole('table', {}, { timeout: 3000 })

    expect(screen.getByText(/not receiving live updates/i)).toBeInTheDocument()
  })
})
