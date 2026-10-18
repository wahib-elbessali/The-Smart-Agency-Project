import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AiSettings from './AiSettings'
import * as aiApi from '@/api/endpoints/aiConfig'
import { ApiError } from '@/api/errors'
import type { AiConfig, AiConfigResult } from '@/api/types'

const CONFIG: AiConfig = {
  config: {
    weapon: { conf: 0.4, imgsz: 640 },
    face: { pack: 'buffalo_s' },
    person_tracking: { diffusion_revive: false },
  },
  apply_modes: {
    weapon: { conf: 'live', imgsz: 'live' },
    face: { pack: 'restart' },
    person_tracking: { diffusion_revive: 'next_start' },
  },
  startup_config: {
    weapon: { conf: 0.25, imgsz: 640 },
    face: { pack: 'buffalo_s' },
    person_tracking: { diffusion_revive: false },
  },
  pending_restart: {},
}

const OK: AiConfigResult = {
  applied: { weapon: { conf: { value: 0.5, mode: 'live' } } },
  pending_restart: {},
  previous: { weapon: { conf: 0.4 } },
  persisted: false,
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AiSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const WAIT = { timeout: 4000 }

describe('AiSettings', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows what is running, how it started and how each key changes', async () => {
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    renderScreen()
    expect(await screen.findByText('Weapon detection', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('Running: 0.4 (started as 0.25)')).toBeInTheDocument()
    expect(screen.getByText('Running: 640')).toBeInTheDocument()
    expect(screen.getByText('After restart')).toBeInTheDocument()
    expect(screen.getByText('Next tracking start')).toBeInTheDocument()
  })

  it('sends only the values that changed, as numbers, and reports the result', async () => {
    const user = userEvent.setup()
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    const patch = vi.spyOn(aiApi, 'patchAiConfig').mockResolvedValue(OK)
    renderScreen()
    const conf = await screen.findByLabelText('conf', {}, WAIT)

    await user.clear(conf)
    await user.type(conf, '0.5')
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }))

    expect(patch).toHaveBeenCalledWith({ changes: { weapon: { conf: 0.5 } }, persist: false })
    expect(await screen.findByText(/Applied: weapon.conf = 0.5/, {}, WAIT)).toBeInTheDocument()
  })

  it('sends persist when "Keep after restart" is on', async () => {
    const user = userEvent.setup()
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    const patch = vi.spyOn(aiApi, 'patchAiConfig').mockResolvedValue({ ...OK, persisted: true })
    renderScreen()
    const pack = await screen.findByLabelText('pack', {}, WAIT)

    await user.clear(pack)
    await user.type(pack, 'buffalo_l')
    await user.click(screen.getByLabelText('Keep after restart'))
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }))

    expect(patch).toHaveBeenCalledWith({ changes: { face: { pack: 'buffalo_l' } }, persist: true })
  })

  it('says weapon.conf is kept after a restart and shared with the Cameras threshold', async () => {
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    renderScreen()
    expect(
      await screen.findByText(/weapon threshold on the Cameras screen too/, {}, WAIT),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/Kept after a restart/)).toHaveLength(1)
  })

  it('does not allow applying text typed into a number field', async () => {
    const user = userEvent.setup()
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    const patch = vi.spyOn(aiApi, 'patchAiConfig')
    renderScreen()
    const conf = await screen.findByLabelText('conf', {}, WAIT)

    await user.clear(conf)
    await user.type(conf, 'abc')

    expect(screen.getByText('Enter a number.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('lists every problem when the AI service rejects the change', async () => {
    const user = userEvent.setup()
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue(CONFIG)
    vi.spyOn(aiApi, 'patchAiConfig').mockRejectedValue(
      new ApiError('http', 'rejected', 422, [
        'weapon.conf must be in (0, 1], got 5',
        'fire.imgsz must be in [32, 4096], got 7',
      ]),
    )
    renderScreen()
    const conf = await screen.findByLabelText('conf', {}, WAIT)

    await user.clear(conf)
    await user.type(conf, '5')
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }))

    expect(
      await screen.findByText('weapon.conf must be in (0, 1], got 5', {}, WAIT),
    ).toBeInTheDocument()
    expect(screen.getByText('fire.imgsz must be in [32, 4096], got 7')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument()
  })

  it('flags settings that are saved but waiting for a restart', async () => {
    vi.spyOn(aiApi, 'fetchAiConfig').mockResolvedValue({
      ...CONFIG,
      pending_restart: { face: { pack: 'buffalo_l' } },
    })
    renderScreen()
    expect(
      await screen.findByText(
        /Waiting for a restart of the AI service: face.pack = buffalo_l/,
        {},
        WAIT,
      ),
    ).toBeInTheDocument()
  })
})
