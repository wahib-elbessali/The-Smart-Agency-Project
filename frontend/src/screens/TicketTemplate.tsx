import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { fetchAgencies, fetchAgency } from '@/api/endpoints/agencies'
import { fetchTicketTemplate, saveTicketTemplate } from '@/api/endpoints/ticketTemplate'
import { ApiError, describeApiError } from '@/api/errors'
import type { TicketTemplateBlock } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'
import {
  BLOCK_TYPES,
  DEFAULT_TEMPLATE,
  PRINTER_WIDTH,
  decodeBitmap,
  isDefaultTemplate,
  moveBlock,
  newBlock,
  readAsDataUri,
  removeBlock,
  replaceBlock,
  validateTemplate,
} from './ticketLayout'

/**
 * The thermal-printer ticket layout, per branch. The backend for this was complete and tested but
 * nothing in the dashboard could reach it, so every branch silently printed the
 * generic French default until somebody noticed.
 *
 * A ticket is an ordered list of blocks; the kiosk turns each into printer
 * commands and picks up a change within about a minute. Four blocks (branch
 * name, ticket number, service, date) are filled in at print time, so the
 * preview shows plausible sample values, not real ones - and the QR block shows
 * a placeholder, since what matters here is where it sits, not its pixels.
 *
 * An image already saved comes back from the server as a processed black and
 * white bitmap, not the file that was uploaded, so that is what the preview
 * draws; the server accepts it back unchanged, so editing other blocks never
 * forces re-uploading the logo.
 */

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export default function TicketTemplate() {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })
  const agencyId = isAdmin
    ? (scope.agencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  return (
    <Screen
      title="Ticket layout"
      description="What the kiosk prints on a visitor's ticket, block by block."
    >
      {isAdmin && (agencies.data?.length ?? 0) > 1 && (
        <div className="mb-4 max-w-xs">
          <select
            aria-label="Branch"
            className={controlClass()}
            value={agencyId ?? ''}
            onChange={(e) => {
              const picked = agencies.data?.find((a) => a.id === e.target.value)
              if (picked) scope.enter({ id: picked.id, name: picked.name })
            }}
          >
            {agencies.data?.map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {agencyId === null ? (
        <p className="text-ink-2 text-sm">No branch to edit yet.</p>
      ) : (
        <Editor key={agencyId} agencyId={agencyId} />
      )}
    </Screen>
  )
}

function Editor({ agencyId }: { agencyId: string }) {
  const queryClient = useQueryClient()
  const template = useQuery({
    queryKey: ['ticket-template', agencyId],
    queryFn: ({ signal }) => fetchTicketTemplate(agencyId, signal),
  })
  const agency = useQuery({
    queryKey: ['agencies', agencyId],
    queryFn: ({ signal }) => fetchAgency(agencyId, signal),
  })

  /* null = untouched, show what the server has. Once edited it is the draft,
     and only a successful save (or discard) puts it back to null. */
  const [draft, setDraft] = useState<TicketTemplateBlock[] | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const saved = template.data?.template ?? []
  const blocks = draft ?? saved
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  const problems = useMemo(() => validateTemplate(blocks), [blocks])

  const save = useMutation({
    mutationFn: () => saveTicketTemplate(agencyId, blocks),
    onSuccess: async (response) => {
      queryClient.setQueryData(['ticket-template', agencyId], response)
      await queryClient.invalidateQueries({ queryKey: ['agencies', agencyId] })
      setDraft(null)
    },
  })

  const edit = (next: TicketTemplateBlock[]) => {
    setFileError(null)
    save.reset()
    setDraft(next)
  }

  return (
    <AsyncBoundary
      isPending={template.isPending}
      error={template.error}
      forbiddenMessage="Ticket layouts are edited by administrators and by managers of their own branch."
      onRetry={() => void template.refetch()}
      skeletonRows={4}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
        <div className="space-y-3">
          <Panel as="section">
            <PanelHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-ink text-sm font-semibold">Layout</h2>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isDefaultTemplate(blocks)}
                    onClick={() => edit([...DEFAULT_TEMPLATE])}
                  >
                    <RotateCcw className="size-3.5" aria-hidden /> Reset to default
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!dirty}
                    onClick={() => {
                      setDraft(null)
                      setFileError(null)
                      save.reset()
                    }}
                  >
                    Discard changes
                  </Button>
                  <Button
                    size="sm"
                    disabled={!dirty || problems.length > 0 || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    <Save className="size-3.5" aria-hidden /> {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
              <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                Blocks print top to bottom. The kiosk picks up a saved change within about a minute.
              </p>
            </PanelHeader>
            <PanelBody className="space-y-2">
              {dirty && problems.length > 0 && (
                <ul role="alert" className="text-warn list-disc space-y-0.5 pl-5 text-xs">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              {fileError && (
                <p role="alert" className="text-warn text-xs">
                  {fileError}
                </p>
              )}
              {save.error && (
                <p role="alert" className="text-warn text-xs">
                  {save.error instanceof ApiError
                    ? describeApiError(save.error)
                    : 'Could not save the layout.'}
                </p>
              )}
              {save.isSuccess && !dirty && (
                <p role="status" className="text-ok text-xs">
                  Saved. The kiosk will print this layout within a minute.
                </p>
              )}

              {blocks.map((block, index) => (
                <BlockCard
                  // Position is the identity: blocks have no id, and reordering
                  // remounts a card, which only loses an unsaved file choice.
                  key={`${index}-${block.type}`}
                  block={block}
                  index={index}
                  count={blocks.length}
                  onChange={(next) => edit(replaceBlock(blocks, index, next))}
                  onMove={(to) => edit(moveBlock(blocks, index, to))}
                  onRemove={() => edit(removeBlock(blocks, index))}
                  onFileError={setFileError}
                />
              ))}

              <div className="border-line border-t pt-3">
                <p className="text-ink-3 mb-2 text-xs">Add a block</p>
                <div className="flex flex-wrap gap-2">
                  {BLOCK_TYPES.map(({ type, label, hint }) => (
                    <Button
                      key={type}
                      size="sm"
                      variant="secondary"
                      title={hint}
                      aria-label={`Add ${label} block`}
                      onClick={() => edit([...blocks, newBlock(type)])}
                    >
                      <Plus className="size-3.5" aria-hidden /> {label}
                    </Button>
                  ))}
                </div>
              </div>
            </PanelBody>
          </Panel>
        </div>

        <Panel as="section" className="self-start">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Preview</h2>
            <p className="text-ink-3 mt-1 text-xs leading-relaxed">
              Sample values for the parts filled in at print time.
            </p>
          </PanelHeader>
          <PanelBody>
            <Receipt blocks={blocks} agencyName={agency.data?.name ?? 'Your branch'} />
          </PanelBody>
        </Panel>
      </div>
    </AsyncBoundary>
  )
}

function BlockCard({
  block,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  onFileError,
}: {
  block: TicketTemplateBlock
  index: number
  count: number
  onChange: (next: TicketTemplateBlock) => void
  onMove: (to: number) => void
  onRemove: () => void
  onFileError: (message: string | null) => void
}) {
  const meta = BLOCK_TYPES.find((entry) => entry.type === block.type)
  const label = `block ${index + 1}, ${meta?.label ?? block.type}`

  return (
    <div className="border-line rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-ink-3 tabular text-xs">{index + 1}</span>
          <span className="text-ink text-sm font-medium">{meta?.label ?? block.type}</span>
          {!(
            block.type === 'text' ||
            block.type === 'qrcode' ||
            block.type === 'image' ||
            block.type === 'spacing'
          ) && <Badge tone="neutral">filled in when printed</Badge>}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Move ${label} up`}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Move ${label} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown className="size-3.5" aria-hidden />
          </Button>
          <Button size="sm" variant="secondary" aria-label={`Remove ${label}`} onClick={onRemove}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {(block.type === 'text' || block.type === 'qrcode') && (
        <input
          aria-label={`${meta?.label} content, ${label}`}
          className={`${controlClass()} mt-2`}
          value={block.content}
          placeholder={block.type === 'qrcode' ? 'https://example.com' : 'Text to print'}
          onChange={(e) => onChange({ ...block, content: e.target.value })}
        />
      )}

      {block.type === 'spacing' && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-ink-2">Lines</span>
          <input
            type="number"
            min={0}
            max={20}
            aria-label={`Blank lines, ${label}`}
            className={`${controlClass()} w-24`}
            value={block.lines}
            onChange={(e) => onChange({ ...block, lines: e.target.valueAsNumber })}
          />
        </label>
      )}

      {block.type === 'image' && (
        <div className="mt-2 space-y-1">
          <input
            type="file"
            accept="image/*"
            aria-label={`Image file, ${label}`}
            className="text-ink-2 text-xs"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > MAX_IMAGE_BYTES) {
                onFileError('That image is over 2 MB - use a smaller one.')
                return
              }
              try {
                onChange({ type: 'image', content: await readAsDataUri(file) })
              } catch {
                onFileError('Could not read that file.')
              }
            }}
          />
          <p className="text-ink-3 text-xs">
            {'data' in block
              ? 'Saved image - choose a file to replace it. Printed in black and white, 384 dots wide.'
              : 'Printed in black and white, scaled to the 384-dot ticket width.'}
          </p>
        </div>
      )}
    </div>
  )
}

const SAMPLE_NUMBER = '20261002-VIR-001'

function Receipt({ blocks, agencyName }: { blocks: TicketTemplateBlock[]; agencyName: string }) {
  const today = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
  return (
    <div
      aria-label="Ticket preview"
      className="mx-auto w-full max-w-[18rem] rounded bg-white px-4 py-5 text-center font-mono text-xs leading-snug text-black shadow-inner"
    >
      {blocks.length === 0 && <p className="text-neutral-400">Nothing to print.</p>}
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <p key={index}>{block.content || ' '}</p>
          case 'agency_name':
            return (
              <p key={index} className="font-bold">
                {agencyName}
              </p>
            )
          case 'ticket_number':
            return (
              <p key={index} className="my-1 text-xl font-bold">
                {SAMPLE_NUMBER}
              </p>
            )
          case 'service_name':
            return <p key={index}>Virement et consultation</p>
          case 'date':
            return <p key={index}>{today}</p>
          case 'qrcode':
            return (
              <div key={index} className="my-2">
                <div
                  className="mx-auto grid size-20 place-items-center border-2 border-black text-[10px]"
                  style={{
                    backgroundImage: 'repeating-conic-gradient(#000 0% 25%, #fff 0% 50%)',
                    backgroundSize: '10px 10px',
                  }}
                  aria-label="QR code placeholder"
                />
                <p className="mt-1 break-all text-[10px] text-neutral-500">
                  {block.content || 'no content yet'}
                </p>
              </div>
            )
          case 'image':
            return (
              <div key={index} className="my-2">
                {'data' in block ? (
                  <BitmapPreview data={block.data} rows={block.rows} />
                ) : block.content ? (
                  <img
                    src={block.content}
                    alt="Uploaded logo"
                    className="mx-auto max-h-32 grayscale"
                  />
                ) : (
                  <p className="text-neutral-400">no image chosen</p>
                )}
              </div>
            )
          case 'spacing':
            return (
              <div
                key={index}
                aria-hidden
                style={{
                  height: `${Math.max(0, Number.isFinite(block.lines) ? block.lines : 0) * 1.25}em`,
                }}
              />
            )
        }
      })}
    </div>
  )
}

/** Draws the saved 1-bit bitmap. Does nothing where there is no canvas (tests). */
function BitmapPreview({ data, rows }: { data: string; rows: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext?.('2d')
    if (!canvas || !context) return
    const bitmap = decodeBitmap(data, rows)
    if (bitmap.length === 0) return
    const image = context.createImageData(PRINTER_WIDTH, bitmap.length)
    bitmap.forEach((row, y) =>
      row.forEach((black, x) => {
        const at = (y * PRINTER_WIDTH + x) * 4
        const value = black ? 0 : 255
        image.data[at] = value
        image.data[at + 1] = value
        image.data[at + 2] = value
        image.data[at + 3] = 255
      }),
    )
    context.putImageData(image, 0, 0)
  }, [data, rows])
  return (
    <canvas
      ref={ref}
      width={PRINTER_WIDTH}
      height={rows}
      aria-label="Saved image"
      className="mx-auto w-full"
    />
  )
}
