import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { fetchAiConfig, patchAiConfig, reloadAiConfig } from '@/api/endpoints/aiConfig'
import { ApiError, describeApiError } from '@/api/errors'
import type {
  AiApplyMode,
  AiConfig,
  AiConfigPatch,
  AiConfigResult,
  AiConfigSection,
  AiConfigValue,
} from '@/api/types'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'

/**
 * Detector tuning for the AI service - contracts/api.md §25, ADMIN only.
 *
 * Every setting shows what is running now, what the AI service booted with
 * (so a live change reads as a difference) and how a change takes effect:
 * live (next detection cycle), on the next tracking start, or only after the
 * AI service restarts. A change is all-or-nothing: if any value is invalid
 * nothing is applied and every problem is listed.
 *
 * Without "Keep after restart" a change lasts until the AI service restarts.
 * Restart-only settings can only be saved with it on, and then wait under
 * "Waiting for a restart" until the service is restarted.
 */

const MODE_LABEL: Record<AiApplyMode, string> = {
  live: 'Live',
  next_start: 'Next tracking start',
  restart: 'After restart',
}
const MODE_TONE: Record<AiApplyMode, Tone> = { live: 'ok', next_start: 'info', restart: 'warn' }

/**
 * Keys that are also alert thresholds: the backend stores them and sets them
 * again whenever the AI service restarts, whichever screen changed them. Say
 * so next to the key, because every other key here reverts on a restart
 * unless "Keep after restart" is on.
 */
const KEPT_BY_BACKEND: Record<string, string> = {
  'weapon.conf': 'It is the weapon threshold on the Cameras screen too.',
  'wanted.threshold': 'It is the match threshold on the Watchlist screen too.',
  'fire.conf': '',
}

const FEATURE_LABEL: Record<string, string> = {
  detector: 'Shared detector',
  weapon: 'Weapon detection',
  fire: 'Fire and gas detection',
  zoning: 'Zones',
  emotion: 'Emotion',
  wanted: 'Wanted-person matching',
  employee_activity: 'Employee activity',
  person_tracking: 'Person tracking',
  face: 'Face recognition',
}

type Drafts = Record<string, string>

const draftKey = (feature: string, key: string) => `${feature}.${key}`

/** Turns what was typed back into the type the AI service reports for the key. */
function parseDraft(
  text: string,
  running: AiConfigValue,
): { value: AiConfigValue } | { error: string } {
  if (typeof running === 'number') {
    const value = Number(text)
    return text.trim() !== '' && Number.isFinite(value) ? { value } : { error: 'Enter a number.' }
  }
  if (typeof running === 'boolean') return { value: text === 'true' }
  return { value: text.trim() === '' ? null : text }
}

function show(value: AiConfigValue): string {
  return value === null ? 'default' : String(value)
}

export default function AiSettings() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => fetchAiConfig(signal),
  })

  const [drafts, setDrafts] = useState<Drafts>({})
  const [persist, setPersist] = useState(false)
  const [result, setResult] = useState<AiConfigResult | null>(null)

  const finish = async (outcome: AiConfigResult) => {
    setResult(outcome)
    setDrafts({})
    await queryClient.invalidateQueries({ queryKey: ['ai-config'] })
  }
  const apply = useMutation({
    mutationFn: (body: AiConfigPatch) => patchAiConfig(body),
    onSuccess: finish,
  })
  const reload = useMutation({ mutationFn: () => reloadAiConfig(), onSuccess: finish })

  const data = query.data
  const { changes, parseErrors } = useMemo(() => buildChanges(data, drafts), [data, drafts])
  const changeCount = Object.values(changes).reduce(
    (n, section) => n + Object.keys(section).length,
    0,
  )
  const pendingRestart = Object.entries(data?.pending_restart ?? {})

  const submitError = apply.error ?? reload.error

  return (
    <Screen
      title="AI tuning"
      description="How sure each detector has to be, how often it looks, and how matching behaves. Applies to every branch."
      actions={
        <Button
          size="sm"
          onClick={() => reload.mutate()}
          disabled={reload.isPending}
          title="Re-read the AI service's saved settings file and apply what differs"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Reload from file
        </Button>
      }
    >
      <AsyncBoundary
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={4}
      >
        {data && (
          <div className="space-y-4">
            {pendingRestart.length > 0 && (
              <p
                role="status"
                className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
              >
                Waiting for a restart of the AI service:{' '}
                {pendingRestart
                  .flatMap(([feature, values]) =>
                    Object.entries(values).map(
                      ([key, value]) => `${feature}.${key} = ${show(value)}`,
                    ),
                  )
                  .join(', ')}
              </p>
            )}

            {result && <ResultNote result={result} />}

            {submitError !== null && <ErrorNote error={submitError} />}

            {Object.entries(data.config).map(([feature, values]) => (
              <FeaturePanel
                key={feature}
                feature={feature}
                values={values}
                startup={data.startup_config[feature] ?? {}}
                modes={data.apply_modes[feature] ?? {}}
                drafts={drafts}
                errors={parseErrors}
                onChange={(key, text) => {
                  setResult(null)
                  apply.reset()
                  setDrafts((current) => ({ ...current, [draftKey(feature, key)]: text }))
                }}
              />
            ))}

            <div className="flex flex-wrap items-center justify-end gap-4">
              <label className="text-ink-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={persist}
                  onChange={(event) => setPersist(event.target.checked)}
                />
                Keep after restart
              </label>
              <Button
                variant="primary"
                disabled={
                  changeCount === 0 || Object.keys(parseErrors).length > 0 || apply.isPending
                }
                onClick={() => apply.mutate({ changes, persist })}
              >
                {changeCount === 0
                  ? 'Apply'
                  : `Apply ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`}
              </Button>
            </div>
          </div>
        )}
      </AsyncBoundary>
    </Screen>
  )
}

function buildChanges(data: AiConfig | undefined, drafts: Drafts) {
  const changes: Record<string, AiConfigSection> = {}
  const parseErrors: Record<string, string> = {}
  if (!data) return { changes, parseErrors }
  for (const [name, text] of Object.entries(drafts)) {
    const [feature = '', key = ''] = name.split('.')
    const running = data.config[feature]?.[key]
    if (running === undefined) continue
    const parsed = parseDraft(text, running)
    if ('error' in parsed) {
      parseErrors[name] = parsed.error
    } else if (parsed.value !== running) {
      changes[feature] = { ...changes[feature], [key]: parsed.value }
    }
  }
  return { changes, parseErrors }
}

function FeaturePanel({
  feature,
  values,
  startup,
  modes,
  drafts,
  errors,
  onChange,
}: {
  feature: string
  values: AiConfigSection
  startup: AiConfigSection
  modes: Record<string, AiApplyMode>
  drafts: Drafts
  errors: Record<string, string>
  onChange: (key: string, text: string) => void
}) {
  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">{FEATURE_LABEL[feature] ?? feature}</h2>
      </PanelHeader>
      <PanelBody>
        <div className="space-y-3">
          {Object.entries(values).map(([key, value]) => {
            const name = draftKey(feature, key)
            const mode = modes[key] ?? 'live'
            const id = `ai-${feature}-${key}`
            const changedFromStartup = show(startup[key] ?? null) !== show(value)
            return (
              <div key={key} className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_12rem]">
                <div>
                  <label htmlFor={id} className="text-ink text-sm font-medium">
                    {key}
                  </label>
                  <p className="text-ink-3 text-xs">
                    Running: {show(value)}
                    {changedFromStartup && ` (started as ${show(startup[key] ?? null)})`}
                  </p>
                  {KEPT_BY_BACKEND[name] !== undefined && (
                    <p className="text-ink-3 text-xs">
                      Kept after a restart. {KEPT_BY_BACKEND[name]}
                    </p>
                  )}
                </div>
                <div>
                  <Badge tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Badge>
                </div>
                <div>
                  {typeof value === 'boolean' ? (
                    <select
                      id={id}
                      className={controlClass(Boolean(errors[name]))}
                      value={drafts[name] ?? String(value)}
                      onChange={(event) => onChange(key, event.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      id={id}
                      className={controlClass(Boolean(errors[name]))}
                      value={drafts[name] ?? (value === null ? '' : String(value))}
                      placeholder={value === null ? 'default' : undefined}
                      inputMode={typeof value === 'number' ? 'decimal' : undefined}
                      aria-invalid={errors[name] ? true : undefined}
                      onChange={(event) => onChange(key, event.target.value)}
                    />
                  )}
                  {errors[name] && <p className="text-warn mt-1 text-xs">{errors[name]}</p>}
                </div>
              </div>
            )
          })}
        </div>
      </PanelBody>
    </Panel>
  )
}

function ResultNote({ result }: { result: AiConfigResult }) {
  const applied = Object.entries(result.applied).flatMap(([feature, keys]) =>
    Object.entries(keys).map(([key, { value }]) => `${feature}.${key} = ${show(value)}`),
  )
  const waiting = Object.keys(result.pending_restart).length > 0
  return (
    <p role="status" className="border-ok/30 bg-ok/8 text-ok rounded-lg border p-3 text-sm">
      {applied.length > 0 ? `Applied: ${applied.join(', ')}.` : 'Nothing needed applying.'}
      {waiting &&
        ' Restart-only settings were saved and take effect after the AI service restarts.'}
      {result.persisted && ' Kept for the next restart.'}
    </p>
  )
}

function ErrorNote({ error }: { error: unknown }) {
  const problems = error instanceof ApiError ? error.errors : []
  return (
    <div role="alert" className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm">
      <p>
        {problems.length > 0
          ? 'Nothing was changed. Fix these and try again:'
          : error instanceof ApiError
            ? describeApiError(error)
            : 'Could not save.'}
      </p>
      {problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
