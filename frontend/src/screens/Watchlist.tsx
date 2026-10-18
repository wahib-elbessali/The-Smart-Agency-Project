import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, Trash2, UserPlus } from 'lucide-react'
import {
  addToWatchlist,
  fetchWantedThreshold,
  fetchWatchlist,
  removeFromWatchlist,
  setWantedThreshold,
} from '@/api/endpoints/watchlist'
import { ApiError, describeApiError } from '@/api/errors'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Screen } from './Screen'

/**
 * The wanted-person watchlist: who the /wanted alert stream matches
 * against, and how sensitive that match is.
 *
 * The Alerts screen already shows a hit when the stream fires one - this is
 * the other half that never existed anywhere: actually managing who's on
 * the list. Separate gallery from face enrollment on purpose, see
 * WatchlistEntry's doc comment in api/types.ts - the two are kept apart so
 * "enrolled employee" and "wanted person" can never be confused with each
 * other, in this UI or in the AI service's own storage.
 */
export default function Watchlist() {
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ['watchlist'],
    queryFn: ({ signal }) => fetchWatchlist(signal),
  })

  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const add = useMutation({
    mutationFn: () => addToWatchlist(name.trim(), file as File),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] })
      setName('')
      setFile(null)
    },
  })

  const remove = useMutation({
    mutationFn: (personName: string) => removeFromWatchlist(personName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !file) return
    add.mutate()
  }

  return (
    <Screen title="Watchlist" description="Who the wanted-person alert matches against.">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">On the list</h2>
            </div>
          </PanelHeader>
          <AsyncBoundary
            isPending={list.isPending}
            error={list.error}
            isEmpty={(list.data ?? []).length === 0}
            emptyMessage="Nobody on the watchlist."
            forbiddenMessage="The watchlist is managed by administrators and managers."
            onRetry={() => void list.refetch()}
            skeletonRows={3}
          >
            <PanelBody>
              <ul className="space-y-2">
                {(list.data ?? []).map((entry) => (
                  <li
                    key={entry.name}
                    className="border-line bg-panel-2 flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">
                      {entry.name}
                    </span>
                    <Badge tone="danger">
                      {entry.embeddings_count} photo{entry.embeddings_count === 1 ? '' : 's'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${entry.name}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(entry.name)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              {remove.error != null && (
                <p
                  role="alert"
                  className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
                >
                  {remove.error instanceof ApiError
                    ? describeApiError(remove.error)
                    : 'Could not remove this person.'}
                </p>
              )}
            </PanelBody>
          </AsyncBoundary>
        </Panel>

        <div className="space-y-3">
          <Panel as="section">
            <PanelHeader>
              <div className="flex items-center gap-2.5">
                <UserPlus className="text-ink-3 size-4 shrink-0" aria-hidden />
                <h2 className="text-ink text-sm font-semibold">Add to the list</h2>
              </div>
              <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                One clear photo, one face. Adding a name already on the list adds this photo to
                their gallery rather than replacing it.
              </p>
            </PanelHeader>
            <PanelBody>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Field id="wanted_name" label="Name" required>
                  {(props) => (
                    <input
                      {...props}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={80}
                    />
                  )}
                </Field>

                <Field id="wanted_photo" label="Photo" required hint="One face, clearly visible.">
                  {(props) => (
                    <input
                      {...props}
                      type="file"
                      accept="image/*"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  )}
                </Field>

                {add.error != null && (
                  <p
                    role="alert"
                    className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
                  >
                    {add.error instanceof ApiError
                      ? describeApiError(add.error)
                      : 'Could not add this photo.'}
                  </p>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  disabled={!name.trim() || !file || add.isPending}
                >
                  {add.isPending ? 'Adding…' : 'Add'}
                </Button>
              </form>
            </PanelBody>
          </Panel>

          <ThresholdPanel />
        </div>
      </div>
    </Screen>
  )
}

function ThresholdPanel() {
  const queryClient = useQueryClient()
  const threshold = useQuery({
    queryKey: ['wantedThreshold'],
    queryFn: ({ signal }) => fetchWantedThreshold(signal),
  })

  const [draft, setDraft] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (value: number) => setWantedThreshold({ threshold: value }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['wantedThreshold'] })
      setDraft(null)
    },
  })

  const current = threshold.data
  const value = draft ?? (current ? String(current.threshold) : '')

  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">Match sensitivity</h2>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          A changed value does not apply instantly
          {current ? ` - up to ${current.applies_within_seconds}s` : ''}, on the detector's next
          cycle, not the next request.
        </p>
      </PanelHeader>
      <PanelBody>
        {threshold.isPending ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : threshold.error ? (
          <p className="text-ink-2 text-sm">
            {threshold.error instanceof ApiError
              ? describeApiError(threshold.error)
              : 'Could not read the threshold.'}
          </p>
        ) : (
          current && (
            <>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={current.floor}
                  max={1}
                  step={0.01}
                  value={value}
                  onChange={(e) => setDraft(e.target.value)}
                  className="flex-1"
                />
                <span className="text-ink tabular w-14 text-right text-sm">
                  {Number(value).toFixed(2)}
                </span>
              </div>
              <p className="text-ink-3 mt-2 text-xs">
                Floor {current.floor.toFixed(2)}, default{' '}
                {current.startup_default.threshold.toFixed(2)}. {current.watchlist_size} people,{' '}
                {current.embeddings_total} photos total.
              </p>

              {save.error != null && (
                <p
                  role="alert"
                  className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
                >
                  {save.error instanceof ApiError
                    ? describeApiError(save.error)
                    : 'Could not save the threshold.'}
                </p>
              )}

              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                disabled={draft === null || save.isPending}
                onClick={() => save.mutate(Number(value))}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </>
          )
        )}
      </PanelBody>
    </Panel>
  )
}
