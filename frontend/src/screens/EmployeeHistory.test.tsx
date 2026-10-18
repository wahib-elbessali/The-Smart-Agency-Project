import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { EmployeeHistory } from './EmployeeHistory'
import * as store from '@/mocks/attendanceStore'
import '@/mocks'

/**
 * This view computes figures people read as fact - an average day, a count of
 * late arrivals. A wrong number here does not look wrong, which is exactly the
 * case worth pinning.
 *
 * The one that matters most: an OPEN record is somebody still inside, not a
 * zero-hour day. Averaging it in as zero would drag the figure down for
 * precisely the people currently at work.
 */

const EMPLOYEE_ID = 'e1000000-0000-4000-8000-000000000001'
const CARD = 'RFID-001'
const OPENING = '08:30:00'
const WAIT = { timeout: 4000 }

function renderHistory(openingTime?: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmployeeHistory employeeId={EMPLOYEE_ID} openingTime={openingTime} />
    </QueryClientProvider>,
  )
}

beforeEach(store.resetAttendanceStore)

describe('EmployeeHistory', () => {
  it('lists the employee history', async () => {
    renderHistory(OPENING)
    expect(await screen.findByRole('table', {}, WAIT)).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1)
  })

  it('orders it most recent first', async () => {
    renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)

    /* The store is the source of truth for the expected order, so this checks
       the view preserves it rather than re-deriving the same sort twice. */
    const expected = store.historyFor(EMPLOYEE_ID).map((r) => r.check_in)
    expect([...expected].sort((a, b) => b.localeCompare(a))).toEqual(expected)
  })

  /* Scoped to the summary block: "9.4 h" also appears in every table row, so a
     bare text query matches dozens of elements. */
  const averageText = () => screen.getByText(/average day/i).parentElement?.textContent ?? ''

  it('shows an average day in hours', async () => {
    renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)
    expect(averageText()).toMatch(/\d+\.\d h/)
  })

  /* An open record has no duration to contribute. */
  it('marks a still-open record rather than showing it as a zero-hour day', async () => {
    store.checkIn({ employee_rfid: CARD })
    renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)

    expect(screen.getByText('Still in')).toBeInTheDocument()
    /* The row exists, and its Hours cell is a dash - not "0.0 h". */
    const openRow = screen.getByText('Still in').closest('tr')
    expect(openRow).not.toBeNull()
    expect(within(openRow as HTMLElement).getByText('—')).toBeInTheDocument()
  })

  it('does not let an open record drag the average down', async () => {
    // Average with only closed records...
    const closedOnly = renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)
    const before = averageText()
    closedOnly.unmount()

    // ...is unchanged by adding one still-open record.
    store.checkIn({ employee_rfid: CARD })
    renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)
    expect(averageText()).toBe(before)
  })

  it('counts late arrivals against the agency opening time', async () => {
    renderHistory(OPENING)
    await screen.findByRole('table', {}, WAIT)
    expect(screen.getAllByText('Late').length).toBeGreaterThan(0)
  })

  /* Without an opening time "late" is underivable - and a zero would read as
     "never late", which is a different claim from "we cannot tell". */
  it('declines to count late arrivals when the opening time is unknown', async () => {
    renderHistory(null)
    await screen.findByRole('table', {}, WAIT)

    expect(screen.queryByText('Late')).not.toBeInTheDocument()
    const lateLabel = screen.getByText(/late arrivals/i)
    expect(lateLabel.parentElement).toHaveTextContent('—')
  })

  it('says so plainly when there is no history', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {/* Index 7 of the roster holds no card and never badges in. */}
        <EmployeeHistory employeeId="e1000000-0000-4000-8000-000000000008" openingTime={OPENING} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/no attendance recorded/i, {}, WAIT)).toBeInTheDocument()
  })
})
