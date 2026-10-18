import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchComparison } from './BranchComparison'
import * as endpoint from '@/api/endpoints/insights'
import { ScopeContext, type ScopeValue } from '@/agency/ScopeContext'
import type { BranchOverview } from '@/api/types'

function branch(name: string, waiting: number, wait: number | null, active = true): BranchOverview {
  return {
    agency_id: `id-${name}`,
    name,
    is_active: active,
    overview: {
      alerts: { open_by_severity: { CRITICAL: 0 }, open_total: 0 },
      tickets: { waiting, in_service: 0, completed_today: 0, cancelled_today: 0 },
      satisfaction: {
        window_hours: 24,
        total_samples: 0,
        counts_by_emotion: {},
        positive_pct: null,
        neutral_pct: null,
        negative_pct: null,
      },
      wait_times: {
        window_hours: 24,
        sample_count: 0,
        avg_queue_wait_seconds: wait,
        avg_walk_over_seconds: null,
        avg_service_duration_seconds: null,
        avg_total_seconds: null,
      },
      visitor_recognition: {
        window_days: 30,
        new_visitors: 0,
        returning_visitors: 0,
        returning_pct: null,
        avg_days_between_visits: null,
      },
      service_satisfaction: {
        window_hours: 24,
        tickets_with_coverage: 0,
        total_samples: 0,
        counts_by_emotion: {},
        positive_pct: null,
        neutral_pct: null,
        negative_pct: null,
      },
    },
  }
}

function renderTable(entered: ScopeValue['enter'] = () => {}) {
  const scope: ScopeValue = { agencyId: null, agencyName: null, enter: entered, leave: () => {} }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ScopeContext value={scope}>
        <BranchComparison />
      </ScopeContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }
const rowNames = () =>
  screen.getAllByRole('rowheader').map((cell) => within(cell).getByRole('button').textContent)

describe('BranchComparison', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists every branch with its numbers, a dash where there is no data yet', async () => {
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([
      branch('Agadir', 9, 600),
      branch('Casa', 4, null),
    ])
    renderTable()
    await screen.findByText('Agadir', {}, WAIT)
    expect(rowNames()).toEqual(['Agadir', 'Casa'])
    const casa = screen.getByText('Casa').closest('tr') as HTMLElement
    expect(within(casa).getByText('4')).toBeInTheDocument()
    expect(within(casa).getAllByText('—').length).toBeGreaterThan(3)
  })

  it('sorts by a column, flips on a second click, and marks the sorted column', async () => {
    const user = userEvent.setup()
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([
      branch('Agadir', 9, 600),
      branch('Casa', 4, 60),
      branch('Rabat', 1, null),
    ])
    renderTable()
    await screen.findByText('Agadir', {}, WAIT)

    const waiting = screen.getByRole('button', { name: /waiting/i })
    await user.click(waiting)
    expect(rowNames()).toEqual(['Agadir', 'Casa', 'Rabat'])
    expect(screen.getByRole('columnheader', { name: /waiting/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    )

    await user.click(waiting)
    expect(rowNames()).toEqual(['Rabat', 'Casa', 'Agadir'])
    expect(screen.getByRole('columnheader', { name: /waiting/i })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: /^branch/i })).toHaveAttribute(
      'aria-sort',
      'none',
    )
  })

  it('keeps branches with no value for the sorted column at the bottom', async () => {
    const user = userEvent.setup()
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([
      branch('A', 1, null),
      branch('B', 1, 600),
      branch('C', 1, 60),
    ])
    renderTable()
    await screen.findByText('A', {}, WAIT)
    await user.click(screen.getByRole('button', { name: /avg wait/i }))
    expect(rowNames()).toEqual(['B', 'C', 'A'])
  })

  it('opens a branch when its name is clicked', async () => {
    const user = userEvent.setup()
    const enter = vi.fn()
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([branch('Casa', 4, null)])
    renderTable(enter)
    await user.click(await screen.findByRole('button', { name: 'Casa' }, WAIT))
    expect(enter).toHaveBeenCalledWith({ id: 'id-Casa', name: 'Casa' })
  })

  it('marks an inactive branch without ranking or colouring anything', async () => {
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([
      branch('Old', 0, null, false),
      branch('New', 3, 60),
    ])
    const { container } = renderTable()
    await screen.findByText('Old', {}, WAIT)
    expect(screen.getByText('Inactive')).toBeInTheDocument()
    expect(container.querySelector('[class*="warn"], [class*="danger"], [class*="bad"]')).toBeNull()
  })

  it('says so when there are no branches', async () => {
    vi.spyOn(endpoint, 'fetchBranchComparison').mockResolvedValue([])
    renderTable()
    expect(await screen.findByText(/nothing to compare/i, {}, WAIT)).toBeInTheDocument()
  })
})
