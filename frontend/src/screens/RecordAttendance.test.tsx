import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { RecordAttendance } from './RecordAttendance'
import { resetAttendanceStore } from '@/mocks/attendanceStore'
import '@/mocks'

/**
 * The point of this screen is that a 200 from check-in does NOT mean somebody
 * was checked in.
 *
 * The contract has the backend return the EXISTING open record, with a 200 and
 * nothing created, when the employee is already inside. Reporting success on
 * any 200 would tell a user "checked in at 14:03" while the record it just
 * received says 08:12 - a false statement about attendance, on a screen people
 * use to decide who is in the building. That distinction is what these tests
 * exist to hold.
 */

const CARD = 'RFID-001'
const WAIT = { timeout: 4000 }

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RecordAttendance onDone={() => {}} />
    </QueryClientProvider>,
  )
}

const cardBox = () => screen.getByLabelText(/card number/i)
const checkInButton = () => screen.getByRole('button', { name: /record check-in/i })
const checkOutButton = () => screen.getByRole('button', { name: /record check-out/i })

beforeEach(resetAttendanceStore)

describe('RecordAttendance', () => {
  it('will not submit an empty card number', () => {
    renderForm()
    expect(checkInButton()).toBeDisabled()
    expect(checkOutButton()).toBeDisabled()
  })

  it('reports a fresh check-in', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), CARD)
    await user.click(checkInButton())

    expect(await screen.findByText(/checked in at/i, {}, WAIT)).toBeInTheDocument()
  })

  /* The whole reason this component compares timestamps. */
  it('says "already inside" instead of claiming a second check-in', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), CARD)
    await user.click(checkInButton())
    await screen.findByText(/checked in at/i, {}, WAIT)

    await user.type(cardBox(), CARD)
    await user.click(checkInButton())

    expect(await screen.findByText(/was already inside since/i, {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument()
  })

  it('reports a check-out', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), CARD)
    await user.click(checkInButton())
    await screen.findByText(/checked in at/i, {}, WAIT)

    await user.type(cardBox(), CARD)
    await user.click(checkOutButton())

    expect(await screen.findByText(/checked out at/i, {}, WAIT)).toBeInTheDocument()
  })

  /* Unlike check-in, check-out genuinely refuses - and the raw
     "server rejected the request (409)" tells the person nothing to act on. */
  it('explains a check-out with no open record', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), CARD)
    await user.click(checkOutButton())

    expect(await screen.findByText(/no open check-in/i, {}, WAIT)).toBeInTheDocument()
  })

  it('explains an unknown card', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), 'RFID-999')
    await user.click(checkInButton())

    expect(
      await screen.findByText(/no active employee holds that card/i, {}, WAIT),
    ).toBeInTheDocument()
  })

  it('clears the field after a successful record, ready for the next person', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(cardBox(), CARD)
    await user.click(checkInButton())
    await screen.findByText(/checked in at/i, {}, WAIT)

    await waitFor(() => {
      expect(cardBox()).toHaveValue('')
    })
  })
})
