import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Reports from './Reports'
import * as agenciesApi from '@/api/endpoints/agencies'
import * as reportsApi from '@/api/endpoints/reports'
import { ScopeContext, type ScopeValue } from '@/agency/ScopeContext'
import { SessionContext, type SessionValue } from '@/auth/SessionContext'
import { mockUserForRole } from '@/mocks/currentUser'
import { describeRange, presetRange } from './reportPeriod'
import type { Agency, AgencyReport, ReportRollup, Role } from '@/api/types'

function report(
  name: string,
  over: Partial<AgencyReport['tickets']> = {},
  id = `id-${name}`,
): AgencyReport {
  return {
    agency_id: id,
    name,
    period: { start: '2026-09-01', end: '2026-09-30', days: 30 },
    generated_at: '2026-10-02T10:00:00Z',
    tickets: {
      created: 120,
      completed: 90,
      cancelled: 20,
      no_show: 10,
      unfinished: 0,
      completion_pct: 75,
      visitors_served: 100,
      ...over,
    },
    wait_times: {
      window_hours: 720,
      sample_count: 90,
      avg_queue_wait_seconds: 330,
      avg_walk_over_seconds: 60,
      avg_service_duration_seconds: 900,
      avg_total_seconds: 1140,
    },
    satisfaction: {
      window_hours: 720,
      total_samples: 40,
      counts_by_emotion: {},
      positive_pct: 60,
      neutral_pct: 15,
      negative_pct: 25,
    },
    service_satisfaction: {
      window_hours: 720,
      tickets_with_coverage: 0,
      total_samples: 0,
      counts_by_emotion: {},
      positive_pct: null,
      neutral_pct: null,
      negative_pct: null,
    },
    alerts: {
      opened_total: 3,
      opened_by_severity: { CRITICAL: 2, HIGH: 1 },
      opened_by_type: { weapon: 2, temperature: 1 },
      resolved: 2,
      avg_resolve_minutes: 60,
    },
    busiest: { day: '2026-09-10', day_tickets: 14, hour_utc: 9, hour_tickets: 31 },
    trends: {
      days: 30,
      opening_seconds_per_day: 28800,
      daily: [
        {
          date: '2026-09-10',
          tickets_completed: 5,
          avg_service_seconds: 800,
          service_samples: 5,
          alerts_opened: 1,
          critical_alerts_opened: 1,
          satisfaction_samples: 4,
          positive_pct: 75,
          negative_pct: 25,
        },
      ],
      counters: [],
      services: [],
    },
  }
}

const agency = (id: string, name: string) => ({ id, name }) as Agency

function renderAs(role: Role, scope: Partial<ScopeValue> = {}, agencyId = 'a1') {
  const session: SessionValue = {
    status: 'authenticated',
    user: { ...mockUserForRole(role), agency_id: role === 'ADMIN' ? null : agencyId },
    signIn: async () => {},
    signOut: () => {},
  }
  const scopeValue: ScopeValue = {
    agencyId: null,
    agencyName: null,
    enter: () => {},
    leave: () => {},
    ...scope,
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext value={session}>
        <ScopeContext value={scopeValue}>
          <MemoryRouter>
            <Reports />
          </MemoryRouter>
        </ScopeContext>
      </SessionContext>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('Reports', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens on last month for a manager, for their own branch', async () => {
    const spy = vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    expect(await screen.findByText(/Agence Casa ·/, {}, WAIT)).toBeInTheDocument()
    const last = presetRange('last_month')
    expect(spy).toHaveBeenCalledWith('a1', last.start, last.end, expect.anything())
    expect(screen.getByText(`Showing ${describeRange(last)}. Days are UTC.`)).toBeInTheDocument()
  })

  it('shows how the tickets ended, how long they took, mood and alerts', async () => {
    vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/Agence Casa ·/, {}, WAIT)
    expect(screen.getByText('How the tickets ended')).toBeInTheDocument()
    expect(screen.getByText('Visitors served').parentElement).toHaveTextContent('100')
    expect(screen.getByText('At the counter').parentElement).toHaveTextContent('15 min')
    expect(screen.getByText('Door to door').parentElement).toHaveTextContent('19 min')
    expect(screen.getByText('weapon · 2')).toBeInTheDocument()
    expect(screen.getByText('Typical time to resolve').parentElement).toHaveTextContent('60 min')
    expect(screen.getByText('Busiest hour').parentElement).toHaveTextContent('09:00')
    expect(screen.getByText('Negative at the counter').parentElement).toHaveTextContent(
      'no counter has a camera linked',
    )
  })

  it('says a finished period will not change, and a period reaching today is a snapshot', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/This period is over/, {}, WAIT)

    const now = presetRange('this_month')
    spy.mockResolvedValue({
      ...report('Agence Casa'),
      period: { start: now.start, end: now.end, days: 2 },
    })
    await user.click(screen.getByRole('button', { name: /this month so far/i }))
    expect(await screen.findByText(/it is a snapshot/i, {}, WAIT)).toBeInTheDocument()
  })

  it('a preset asks for exactly its range', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/Agence Casa ·/, {}, WAIT)
    await user.click(screen.getByRole('button', { name: /last 30 days/i }))
    const range = presetRange('last_30')
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('a1', range.start, range.end, expect.anything()),
    )
  })

  it('takes a custom range only when it is valid, and says why when it is not', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/Agence Casa ·/, {}, WAIT)

    const from = screen.getByLabelText('From')
    const to = screen.getByLabelText('To')
    await user.clear(from)
    await user.type(from, '2026-09-20')
    await user.clear(to)
    await user.type(to, '2026-09-05')
    expect(screen.getByRole('alert')).toHaveTextContent(/before the start/i)
    expect(screen.getByRole('button', { name: /show report/i })).toBeDisabled()

    await user.clear(to)
    await user.type(to, '2026-09-25')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /show report/i }))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('a1', '2026-09-20', '2026-09-25', expect.anything()),
    )
  })

  it('refuses a future end date', async () => {
    const user = userEvent.setup()
    vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/Agence Casa ·/, {}, WAIT)
    const to = screen.getByLabelText('To')
    await user.clear(to)
    await user.type(to, '2999-01-01')
    expect(screen.getByRole('alert')).toHaveTextContent(/future/i)
  })

  it('does not fetch again by itself - a report is not a live view', async () => {
    const spy = vi.spyOn(reportsApi, 'fetchAgencyReport').mockResolvedValue(report('Agence Casa'))
    renderAs('MANAGER')
    await screen.findByText(/Agence Casa ·/, {}, WAIT)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('gives an admin with several branches the rollup, totals last, and opens a branch from it', async () => {
    const user = userEvent.setup()
    vi.spyOn(agenciesApi, 'fetchAgencies').mockResolvedValue([
      agency('a1', 'Casa'),
      agency('a2', 'Rabat'),
    ])
    const rollup: ReportRollup = {
      period: { start: '2026-09-01', end: '2026-09-30', days: 30 },
      branches: [
        report('Casa', {}, 'a1'),
        report('Rabat', { created: 50, completed: 25, completion_pct: 50 }, 'a2'),
      ],
      totals: report('All branches', { created: 170, completed: 115, completion_pct: 67.6 }, 'all'),
    }
    vi.spyOn(reportsApi, 'fetchBranchRollup').mockResolvedValue(rollup)
    const enter = vi.fn()
    renderAs('ADMIN', { enter })

    await screen.findByText(/All branches ·/, {}, WAIT)
    const rows = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
    expect(rows).toEqual(['Casa', 'Rabat', 'All branches'])
    const totals = screen
      .getByText('All branches', { selector: 'span' })
      .closest('tr') as HTMLElement
    expect(within(totals).getByText('170')).toBeInTheDocument()
    expect(within(totals).getByText('68%')).toBeInTheDocument()
    expect(screen.getByText(/not by averaging the rows above it/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Rabat' }))
    expect(enter).toHaveBeenCalledWith({ id: 'a2', name: 'Rabat' })
  })

  it('shows one branch in full once an admin has chosen it', async () => {
    vi.spyOn(agenciesApi, 'fetchAgencies').mockResolvedValue([
      agency('a1', 'Casa'),
      agency('a2', 'Rabat'),
    ])
    const spy = vi
      .spyOn(reportsApi, 'fetchAgencyReport')
      .mockResolvedValue(report('Rabat', {}, 'a2'))
    renderAs('ADMIN', { agencyId: 'a2', agencyName: 'Rabat' })
    expect(await screen.findByText(/Rabat ·/, {}, WAIT)).toBeInTheDocument()
    expect(spy).toHaveBeenCalledWith(
      'a2',
      expect.any(String),
      expect.any(String),
      expect.anything(),
    )
    expect(screen.queryByText(/not by averaging/i)).not.toBeInTheDocument()
  })

  it('goes straight to the one branch when an admin has only one', async () => {
    vi.spyOn(agenciesApi, 'fetchAgencies').mockResolvedValue([agency('a1', 'Casa')])
    const spy = vi
      .spyOn(reportsApi, 'fetchAgencyReport')
      .mockResolvedValue(report('Casa', {}, 'a1'))
    renderAs('ADMIN')
    expect(await screen.findByText(/Casa ·/, {}, WAIT)).toBeInTheDocument()
    expect(spy).toHaveBeenCalledWith(
      'a1',
      expect.any(String),
      expect.any(String),
      expect.anything(),
    )
  })
})
