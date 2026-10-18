import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanFace, Trash2, UserPlus } from 'lucide-react'
import { deleteFace, enrollFace, fetchFaces } from '@/api/endpoints/face'
import { ApiError, describeApiError } from '@/api/errors'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Screen } from './Screen'

/**
 * Enrolling staff for face-based access - ENROLLMENT ONLY.
 *
 * ai/features/face_recognition/api.py has two more routes, /face/scan and
 * /face/capture, deliberately not built here. Those are backend-triggered
 * against a real hardware event (a gate camera, a kiosk), the same way
 * POST /internal/access/door-access fires off an RFID badge read rather
 * than a dashboard button - see FaceEntry's doc comment in api/types.ts.
 * Nothing on the backend orchestrates that yet either, so there is no
 * result to show here and no trigger to build.
 *
 * What's real to build: plain roster management. Add a name and a photo,
 * see who's enrolled with how many photos, remove someone. No camera
 * imagery on this screen at all - the photo goes straight to the service,
 * this dashboard never re-displays it.
 */
export default function FaceEnrollment() {
  const queryClient = useQueryClient()
  const faces = useQuery({
    queryKey: ['faces'],
    queryFn: ({ signal }) => fetchFaces(signal),
  })

  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const enroll = useMutation({
    mutationFn: () => enrollFace(name.trim(), file as File),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['faces'] })
      setName('')
      setFile(null)
    },
  })

  const remove = useMutation({
    mutationFn: (personName: string) => deleteFace(personName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['faces'] })
    },
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !file) return
    enroll.mutate()
  }

  return (
    <Screen
      title="Face enrollment"
      description="Staff faces the access system recognizes automatically - one photo per submission, add more anytime. Faces for badge + face doors are not listed here: they are added on each employee's own form."
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <ScanFace className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Enrolled</h2>
            </div>
          </PanelHeader>
          <AsyncBoundary
            isPending={faces.isPending}
            error={faces.error}
            isEmpty={(faces.data ?? []).length === 0}
            emptyMessage="Nobody enrolled yet."
            forbiddenMessage="Face enrollment is managed by administrators and managers."
            onRetry={() => void faces.refetch()}
            skeletonRows={3}
          >
            <PanelBody>
              <ul className="space-y-2">
                {(faces.data ?? []).map((entry) => (
                  <li
                    key={entry.name}
                    className="border-line bg-panel-2 flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">
                      {entry.name}
                    </span>
                    <Badge tone="neutral">
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

        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <UserPlus className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Enroll someone</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs leading-relaxed">
              One clear photo, one face in it. Enrolling a name already on the list adds this photo
              to their gallery rather than replacing it - more photos means better recognition
              across angles and lighting.
            </p>
          </PanelHeader>
          <PanelBody>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field id="face_name" label="Name" required>
                {(props) => (
                  <input
                    {...props}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                  />
                )}
              </Field>

              <Field id="face_photo" label="Photo" required hint="One face, clearly visible.">
                {(props) => (
                  <input
                    {...props}
                    type="file"
                    accept="image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                )}
              </Field>

              {enroll.error != null && (
                <p
                  role="alert"
                  className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
                >
                  {enroll.error instanceof ApiError
                    ? describeApiError(enroll.error)
                    : 'Could not enroll this photo.'}
                </p>
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={!name.trim() || !file || enroll.isPending}
              >
                {enroll.isPending ? 'Enrolling…' : 'Enroll'}
              </Button>
            </form>
          </PanelBody>
        </Panel>
      </div>
    </Screen>
  )
}
