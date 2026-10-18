import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, Cpu, HelpCircle, KeyRound, Lock, LockOpen, XCircle } from 'lucide-react'
import { fetchControlCommands, sendControlCommand } from '@/api/endpoints/controls'
import { fetchDevices } from '@/api/endpoints/devices'
import { ApiError, describeApiError } from '@/api/errors'
import type { Device, DeviceCommand, ManualControlResult } from '@/api/types'
import { useScope, withinScope } from '@/agency/ScopeContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Screen } from './Screen'

/**
 * Manual hardware overrides - one command at a time, to one device.
 * contracts/api.md, added 2026-09-23. ADMIN, MANAGER and SECURITY.
 *
 * UX decided with the user (2026-09-23): spinner while the command is in
 * flight, then confirmed/failed/unknown from the response, never a guessed
 * success. No auto-retry - only a fresh manual click sends another command.
 *
 * A button per command, not a free-text action (2026-10-18): the commands
 * and their labels come from contracts/device-commands.json (through GET
 * /api/controls/commands), the one list the firmware implements too, and the
 * backend refuses any other. A typed "unlcok" used to go to the device and
 * come back failed or unknown with no clue why. Nothing about a command is
 * hardcoded here; the icons below are only decoration for known ones.
 */

const RESULT_TONE: Record<ManualControlResult['status'], Tone> = {
  confirmed: 'ok',
  failed: 'danger',
  unknown: 'neutral',
}

const RESULT_ICON: Record<ManualControlResult['status'], typeof CheckCircle2> = {
  confirmed: CheckCircle2,
  failed: XCircle,
  unknown: HelpCircle,
}

const RESULT_LABEL: Record<ManualControlResult['status'], string> = {
  confirmed: 'Confirmed',
  failed: 'Failed',
  unknown: 'Unknown - no reply in time, check the device',
}

const COMMAND_ICON: Record<string, typeof Lock> = { lock: Lock, unlock: LockOpen }

export default function ManualControls() {
  const scope = useScope()
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => fetchDevices(signal),
  })
  const commands = useQuery({
    queryKey: ['controlCommands'],
    queryFn: ({ signal }) => fetchControlCommands(signal),
    staleTime: Infinity,
  })
  const rows = withinScope(devices.data ?? [], scope.agencyId)
  const commandsFor = (device: Device) => commands.data?.[device.device_type.toUpperCase()] ?? []
  const controllable = rows.filter((device) => commandsFor(device).length > 0)
  const others = rows.filter((device) => commandsFor(device).length === 0)

  return (
    <Screen
      title="Manual controls"
      description="Lock or unlock a door from here; the device confirms it did."
    >
      <AsyncBoundary
        isPending={devices.isPending || commands.isPending}
        error={devices.error ?? commands.error}
        isEmpty={rows.length === 0}
        emptyMessage="No devices registered yet."
        forbiddenMessage="Manual controls are limited to administrators, managers and security. Ask an administrator if you need access."
        onRetry={() => void Promise.all([devices.refetch(), commands.refetch()])}
        skeletonRows={4}
      >
        {controllable.length === 0 ? (
          <p className="text-ink-2 text-sm">No device in this branch takes manual commands.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {controllable.map((device) => (
              <DeviceControlPanel key={device.id} device={device} commands={commandsFor(device)} />
            ))}
          </div>
        )}
        {others.length > 0 && (
          <p className="text-ink-3 mt-4 text-xs leading-relaxed">
            No manual commands for {others.map((device) => device.name).join(', ')}: these devices
            run on their own (sensors, kiosk, display).
          </p>
        )}
      </AsyncBoundary>
    </Screen>
  )
}

function DeviceControlPanel({ device, commands }: { device: Device; commands: DeviceCommand[] }) {
  const [result, setResult] = useState<ManualControlResult | null>(null)

  const send = useMutation({
    mutationFn: (action: string) => sendControlCommand(device.id, { action }),
    onMutate: () => setResult(null),
    onSuccess: (response) => setResult(response),
  })

  const ResultIcon = result ? RESULT_ICON[result.status] : null

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <Cpu className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink truncate text-sm font-semibold">{device.name}</h2>
        </div>
        <p className="text-ink-3 mt-1 truncate text-xs">
          {device.device_type} · {device.mqtt_client_id}
        </p>
      </PanelHeader>
      <PanelBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {commands.map(({ action, label }) => {
            const Icon = COMMAND_ICON[action] ?? KeyRound
            const pending = send.isPending && send.variables === action
            return (
              <Button
                key={action}
                size="sm"
                variant="primary"
                disabled={send.isPending}
                onClick={() => send.mutate(action)}
              >
                <Icon className={`size-3.5 ${pending ? 'animate-pulse' : ''}`} aria-hidden />
                {pending ? 'Sending…' : label}
              </Button>
            )
          })}
        </div>

        {result && ResultIcon && (
          <Badge
            tone={RESULT_TONE[result.status]}
            icon={<ResultIcon className="size-3" aria-hidden />}
          >
            {RESULT_LABEL[result.status]}
            {result.detail ? ` · ${result.detail}` : ''}
          </Badge>
        )}

        {send.error !== null && (
          <p role="alert" className="text-warn text-xs">
            {send.error instanceof ApiError
              ? describeApiError(send.error)
              : 'Could not send command.'}
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}
