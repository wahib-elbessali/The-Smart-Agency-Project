import { useState, type FormEvent } from 'react'
import {
  CAMERA_AI_FEATURES,
  type Camera,
  type CameraAiFeature,
  type CameraCreate,
} from '@/api/types'
import { ApiError, describeApiError } from '@/api/errors'
import { CAMERA_FEATURE_LABEL } from './cameraFeatures'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/**
 * Create / edit form for one camera.
 *
 * Two fields, both required, same shape for POST and PUT - so like
 * ServiceForm there is no create-vs-edit split, only the submit label. The
 * name deserves the one hint on this form: it is not a label for people, it
 * is the identifier the AI service files detections under, and a camera the
 * detector knows by another name never appears on the Alerts screen.
 */

export type CameraFormValues = CameraCreate & { ai_features: CameraAiFeature[] }

function initialValues(camera: Camera | null): CameraFormValues {
  return {
    name: camera?.name ?? '',
    stream_url: camera?.stream_url ?? '',
    /* null on the server means every detection - shown as all ticked. */
    ai_features: camera?.ai_features ?? [...CAMERA_AI_FEATURES],
  }
}

/** Matches Field(min_length=1, max_length=150) on name. */
function nameError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length > 150) return 'At most 150 characters.'
  return undefined
}

/** Matches Field(min_length=1, max_length=500) and the scheme check on stream_url. */
function streamUrlError(value: string, touched: boolean): string | undefined {
  if (!touched) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'Required.'
  if (trimmed.length > 500) return 'At most 500 characters.'
  if (!/^(rtsps?|https?):\/\/[^/\s]+/i.test(trimmed)) {
    return 'Use an rtsp://, rtsps://, http:// or https:// address.'
  }
  return undefined
}

/**
 * Refusals verified against backend/app/api/cameras.py:
 *   409  name OR stream_url already used by a camera at any branch (both
 *        unique site-wide), or a rename of a camera that has a calibration or
 *        zones under its old name. Same status for all, told apart only by the
 *        French `detail`, which this file won't string-match (see
 *        api/errors.ts) - so the message names every cause.
 *   403  the camera or branch belongs to another agency
 *   404  the branch no longer exists
 */
function saveErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not save.'

  switch (error.status) {
    case 409:
      return 'Another camera already uses that name or that stream URL (possibly at another branch; both are unique across all branches, because the detector knows cameras by name and one stream can only feed one camera), or you are renaming a camera that already has a calibration or zones. Delete those first.'
    case 403:
      return 'That camera belongs to another branch.'
    case 404:
      return 'That branch no longer exists.'
    case 422:
      return 'The server rejected one of these values. Both fields are required, have a maximum length, and the feed must be an rtsp, rtsps, http or https address.'
    default:
      return describeApiError(error)
  }
}

export function CameraForm({
  camera,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  camera: Camera | null
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: CameraFormValues) => void
}) {
  const editing = camera !== null
  const [values, setValues] = useState(() => initialValues(camera))
  const [touched, setTouched] = useState(false)

  const set = <K extends keyof CameraFormValues>(key: K, value: CameraFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const invalid =
    nameError(values.name, true) !== undefined ||
    streamUrlError(values.stream_url, true) !== undefined

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (invalid) return

    onSubmit({
      name: values.name.trim(),
      stream_url: values.stream_url.trim(),
      ai_features: CAMERA_AI_FEATURES.filter((feature) => values.ai_features.includes(feature)),
    })
  }

  const serverMessage = saveErrorMessage(error)

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        id="camera_name"
        label="Name"
        required
        error={nameError(values.name, touched)}
        hint="The source name the detector uses. Unique across every branch."
      >
        {(props) => (
          <input
            {...props}
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="cam-lobby"
          />
        )}
      </Field>

      <Field
        id="camera_stream_url"
        label="Stream URL"
        required
        error={streamUrlError(values.stream_url, touched)}
        hint="Where the detector reads the feed from, usually an rtsp:// address."
      >
        {(props) => (
          <input
            {...props}
            value={values.stream_url}
            onChange={(e) => set('stream_url', e.target.value)}
            placeholder="rtsp://192.168.1.16:8554/stream"
          />
        )}
      </Field>

      <fieldset>
        <legend className="text-ink-2 text-sm font-medium">Detections this camera runs</legend>
        <p className="text-ink-3 mt-0.5 text-xs">
          Untick what this camera cannot see well - face detections need a camera facing visitors at
          head height, not one on the ceiling. Tracking and zones are set on their own screens.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {CAMERA_AI_FEATURES.map((feature) => (
            <label key={feature} className="text-ink flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.ai_features.includes(feature)}
                onChange={(e) =>
                  set(
                    'ai_features',
                    e.target.checked
                      ? [...values.ai_features, feature]
                      : values.ai_features.filter((f) => f !== feature),
                  )
                }
              />
              {CAMERA_FEATURE_LABEL[feature]}
            </label>
          ))}
        </div>
      </fieldset>

      {serverMessage && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
        >
          {serverMessage}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onCancel} type="button">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add camera'}
        </Button>
      </div>
    </form>
  )
}
