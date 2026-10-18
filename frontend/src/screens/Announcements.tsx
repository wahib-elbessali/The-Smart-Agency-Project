import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Plus, Radio, Trash2 } from 'lucide-react'
import {
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncements,
} from '@/api/endpoints/announcements'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { ApiError, describeApiError } from '@/api/errors'
import type { Agency, Announcement } from '@/api/types'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Clock } from '@/components/ui/Time'
import { Screen } from './Screen'

/**
 * Broadcast messages to employees - contracts/api.md, added 2026-09-23.
 * "PR" in the feature list; nothing more than this screen and the route
 * behind it.
 *
 * Reading is every signed-in role - an announcement is for employees, not
 * one branch's staff. Posting and deleting are ADMIN and MANAGER only, and
 * only an ADMIN may post one with no agency (a site-wide broadcast) - the
 * form only offers that option to an ADMIN, and the backend enforces it
 * again regardless.
 */

export default function Announcements() {
  const { user } = useSession()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const canWrite = isAdmin || user?.role === 'MANAGER'

  const announcements = useQuery({
    queryKey: ['announcements'],
    queryFn: ({ signal }) => fetchAnnouncements(signal),
  })

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: canWrite,
  })

  const [posting, setPosting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Announcement | null>(null)

  const post = useMutation({
    mutationFn: (body: { title: string; message: string; agency_id: string | null }) =>
      createAnnouncement(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['announcements'] })
      setPosting(false)
    },
  })

  const remove = useMutation({
    mutationFn: (announcement: Announcement) => deleteAnnouncement(announcement.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['announcements'] })
      setConfirmingDelete(null)
    },
  })

  const rows = announcements.data ?? []
  /* Names resolve only for the roles that can fetch the agency list
     (ADMIN/MANAGER - GET /api/agencies 403s for everyone else). A non-write
     role never sees an id it cannot resolve: the backend already scopes
     their reads to site-wide plus their own agency, so any non-null
     agency_id they see is their own branch. */
  const agencyName = useMemo(() => {
    const byId = new Map((agencies.data ?? []).map((agency) => [agency.id, agency.name]))
    return (id: string | null) => {
      if (id === null) return null
      return byId.get(id) ?? (canWrite ? id : 'This branch')
    }
  }, [agencies.data, canWrite])

  return (
    <Screen
      title="Announcements"
      description="Messages broadcast to employees, site-wide or for one branch."
      actions={
        canWrite && (
          <Button variant="primary" size="sm" onClick={() => setPosting(true)}>
            <Plus className="size-3.5" aria-hidden />
            Post announcement
          </Button>
        )
      }
    >
      <AsyncBoundary
        isPending={announcements.isPending}
        error={announcements.error}
        isEmpty={rows.length === 0}
        emptyMessage="No announcements yet."
        onRetry={() => void announcements.refetch()}
        skeletonRows={3}
      >
        <div className="space-y-3">
          {rows.map((announcement) => (
            <Panel as="section" key={announcement.id}>
              <PanelHeader
                action={
                  canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(announcement)}
                      aria-label={`Delete ${announcement.title}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  )
                }
              >
                <div className="flex items-center gap-2.5">
                  <Megaphone className="text-ink-3 size-4 shrink-0" aria-hidden />
                  <h2 className="text-ink truncate text-sm font-semibold">{announcement.title}</h2>
                  {announcement.agency_id === null ? (
                    <Badge tone="info" icon={<Radio className="size-3" aria-hidden />}>
                      Site-wide
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      {agencyName(announcement.agency_id) ?? 'One branch'}
                    </Badge>
                  )}
                </div>
                <p className="text-ink-3 mt-1 text-xs">
                  <Clock iso={announcement.created_at} />
                </p>
              </PanelHeader>
              <PanelBody>
                <p className="text-ink-2 text-sm leading-relaxed whitespace-pre-wrap">
                  {announcement.message}
                </p>
              </PanelBody>
            </Panel>
          ))}
        </div>
      </AsyncBoundary>

      <Dialog
        open={posting}
        title="Post an announcement"
        description="Every signed-in employee sees this. There is no way to target it more narrowly than one branch."
        onClose={() => {
          setPosting(false)
          post.reset()
        }}
      >
        {posting && (
          <AnnouncementForm
            agencies={agencies.data ?? []}
            canPostSiteWide={isAdmin}
            defaultAgencyId={user?.agency_id ?? null}
            pending={post.isPending}
            error={post.error}
            onCancel={() => {
              setPosting(false)
              post.reset()
            }}
            onSubmit={(values) => post.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this announcement?"
        description="It disappears from every employee's view immediately."
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            {remove.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mb-4 rounded-lg border p-3 text-sm"
              >
                {remove.error instanceof ApiError
                  ? describeApiError(remove.error)
                  : 'Could not delete.'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setConfirmingDelete(null)
                  remove.reset()
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmingDelete)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Screen>
  )
}

function AnnouncementForm({
  agencies,
  canPostSiteWide,
  defaultAgencyId,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  agencies: Agency[]
  canPostSiteWide: boolean
  defaultAgencyId: string | null
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: { title: string; message: string; agency_id: string | null }) => void
}) {
  /* "" stands for site-wide in this select only - the value sent on submit is
     null, never the empty string, since AnnouncementCreate.agency_id is
     string | null. */
  const [agencyId, setAgencyId] = useState(defaultAgencyId ?? '')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')

  const trimmedTitle = title.trim()
  const trimmedMessage = message.trim()
  const invalid = trimmedTitle === '' || trimmedMessage === ''

  function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid) return
    onSubmit({
      title: trimmedTitle,
      message: trimmedMessage,
      agency_id: agencyId === '' ? null : agencyId,
    })
  }

  const message_ = useMemo(() => {
    if (error == null) return null
    if (!(error instanceof ApiError)) return 'Could not post.'
    return describeApiError(error)
  }, [error])

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="announcement_title" label="Title" required>
        {(props) => (
          <input
            {...props}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={150}
            autoFocus
          />
        )}
      </Field>

      <Field id="announcement_message" label="Message" required>
        {(props) => (
          <textarea
            {...props}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
            rows={5}
          />
        )}
      </Field>

      {canPostSiteWide && (
        <Field id="announcement_agency" label="Audience" hint="Site-wide reaches every branch.">
          {(props) => (
            <select
              {...props}
              className={controlClass()}
              value={agencyId}
              onChange={(e) => setAgencyId(e.target.value)}
            >
              <option value="">Site-wide</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {message_ && (
        <p role="alert" className="text-warn text-sm">
          {message_}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || invalid}>
          {pending ? 'Posting…' : 'Post'}
        </Button>
      </div>
    </form>
  )
}
