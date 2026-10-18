import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { EmployeeFacePanel } from './EmployeeFacePanel'

const face = vi.hoisted(() => ({ enrolled: false, photos: 0 }))
vi.mock('@/api/endpoints/employeeFaces', () => ({
  fetchEmployeeFace: vi.fn(async () => ({ ...face })),
  enrollEmployeeFace: vi.fn(async () => {
    face.enrolled = true
    face.photos += 1
    return { ...face }
  }),
  deleteEmployeeFace: vi.fn(async () => undefined),
}))

describe('EmployeeFacePanel', () => {
  /* 2026-10-18 day test: the photo was picked, the form's Save clicked, and
     nothing enrolled - a separate "Add photo" button was easy to miss. */
  it('uploads the photo the moment it is picked', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmployeeFacePanel employeeId="emp-1" />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/Not enrolled/)).toBeInTheDocument()

    const photo = new File(['x'], 'me.jpg', { type: 'image/jpeg' })
    await userEvent.upload(screen.getByLabelText('Add a face photo'), photo)

    await waitFor(() => expect(screen.getByText(/Enrolled \(1 photo\)/)).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Photo added.')
    expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument()
  })
})
