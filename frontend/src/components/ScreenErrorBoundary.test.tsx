import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScreenErrorBoundary } from './ScreenErrorBoundary'

function Broken(): never {
  throw new Error('boom')
}

describe('ScreenErrorBoundary', () => {
  it('shows an error panel instead of unmounting everything', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <nav>still here</nav>
        <ScreenErrorBoundary>
          <Broken />
        </ScreenErrorBoundary>
      </div>,
    )
    expect(screen.getByText('still here')).toBeInTheDocument()
    expect(screen.getByText('This screen hit an error')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    spy.mockRestore()
  })
})
