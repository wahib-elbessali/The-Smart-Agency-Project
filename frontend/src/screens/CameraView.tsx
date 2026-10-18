import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { ArrowLeft, Camera as CameraIcon, ImageOff } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchCameraFrame, fetchCameras } from '@/api/endpoints/cameras'
import { createAlertStream } from '@/api/endpoints/streams'
import { ApiError } from '@/api/errors'
import { applyAlertFrame, type AlertsByCamera } from '@/api/streamMerge'
import type { AlertDetection, AlertFrame, Camera, DeviceStatus } from '@/api/types'
import { useSession } from '@/auth/SessionContext'
import { useStream } from '@/hooks/useStream'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StreamStatusBadge } from '@/components/StreamStatusBadge'
import { Screen } from './Screen'

/**
 * One camera, live: what the detector currently sees, with its weapon
 * detections drawn over it. The "Live view" panel of ai/reference_ui/console,
 * rebuilt on this side of the backend. Added 2026-09-12.
 *
 * WHAT IS LIVE AND WHAT IS NOT
 *
 * The picture is a still, refetched every two seconds - PROPOSED
 * GET /api/cameras/{id}/frame (api/endpoints/cameras.ts), which the backend
 * forwards from the AI service's own GET /frame. Not video: `stream_url` is
 * RTSP, which no browser plays, and the AI service has no video route to
 * proxy either. Two seconds matches the detectors' update_interval
 * (ai-service.md GET /config), so a faster poll would show the same frame
 * twice. The boxes ARE live - they come from the weapon alert stream this
 * dashboard already listens to on the Alerts screen, filtered to this
 * camera's name.
 *
 * WHY THE BOXES LINE UP
 *
 * The AI service returns the frame at the size the detectors see (its
 * `camera=` lookup applies the per-camera quality), and bbox is in those same
 * source pixels. So the overlay is an SVG with viewBox = the image's natural
 * size and the same object-fit as the image, and every box is drawn in raw
 * pixel coordinates - no scaling maths in here to get wrong. Renaming a
 * camera breaks this until the backend re-syncs its sources, since the
 * stream speaks the old name; the Cameras screen says so.
 *
 * WEAPON ONLY, FOR NOW
 *
 * The backend consumes exactly one of the AI service's four alert streams
 * (app/ai_alerts/consumer.py), and it is the one with a threshold and a
 * camera table behind it. The other three exist in endpoints/streams.ts as
 * PROPOSED and will drop in here as a switcher, the way Alerts.tsx has one,
 * when backend wires them.
 *
 * FINDING THE CAMERA
 *
 * There is no GET /api/cameras/{id} in the contract - only the per-agency
 * list - so a deep link resolves the camera by listing: one agency for a
 * MANAGER or SECURITY, every agency for an ADMIN. Cheap, and it means the
 * URL survives a reload rather than depending on state passed from the list.
 */

const STATUS_TONE: Record<DeviceStatus, Tone> = {
  ONLINE: 'ok',
  OFFLINE: 'neutral',
  ERROR: 'danger',
  MAINTENANCE: 'warn',
}

const FRAME_MS = 2_000

export default function CameraView() {
  const { id = '' } = useParams()
  const { user } = useSession()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })
  const agencyIds = useMemo(
    () =>
      isAdmin ? (agencies.data ?? []).map((a) => a.id) : user?.agency_id ? [user.agency_id] : [],
    [isAdmin, agencies.data, user?.agency_id],
  )
  const lists = useQueries({
    queries: agencyIds.map((agencyId) => ({
      queryKey: ['cameras', agencyId],
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchCameras(agencyId, signal),
    })),
  })
  const camera: Camera | null = lists.flatMap((q) => q.data ?? []).find((c) => c.id === id) ?? null
  const looking = (isAdmin && agencies.isPending) || lists.some((q) => q.isPending)

  return (
    <Screen
      title={camera?.name ?? 'Camera'}
      description="What the detector sees right now, and what it is flagging."
      actions={
        <Link
          to="/cameras"
          className="text-ink-2 hover:text-ink ease-soft inline-flex items-center gap-2 text-sm transition-colors duration-150"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          All cameras
        </Link>
      }
    >
      {camera ? (
        <LiveView camera={camera} />
      ) : looking ? (
        <p className="text-ink-3 text-sm">Finding this camera…</p>
      ) : (
        <Panel as="section">
          <PanelBody>
            <p className="text-ink-2 text-sm">
              No camera with this id in the branches you can see. It may have been deleted, or it
              belongs to another branch.
            </p>
          </PanelBody>
        </Panel>
      )}
    </Screen>
  )
}

function LiveView({ camera }: { camera: Camera }) {
  const frame = useQuery({
    queryKey: ['cameraFrame', camera.id],
    queryFn: ({ signal }) => fetchCameraFrame(camera.id, signal),
    refetchInterval: FRAME_MS,
    /* A 404 is the AI service saying it cannot open the stream; asking again
       in two seconds is the retry, and a backoff would only make the picture
       come back later than the camera did. */
    retry: false,
    /* The previous frame stays up while the next one loads, so the picture
       does not blink to a skeleton twice a second. */
    placeholderData: (previous) => previous,
    gcTime: 0,
  })

  /* A Blob needs an object URL to be an <img>, and every URL made has to be
     revoked or the tab leaks a frame every two seconds for as long as it is
     open. */
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!frame.data) return
    const url = URL.createObjectURL(frame.data)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [frame.data])

  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  const { state: alerts, status } = useStream<AlertFrame, AlertsByCamera>(
    'weapon',
    () => createAlertStream('weapon'),
    applyAlertFrame,
    () => ({}),
  )
  const detections = alerts[camera.name] ?? []

  const noFrame = frame.isError
  const unavailable =
    frame.error instanceof ApiError && frame.error.status === 404
      ? 'The detector cannot open this camera’s stream right now.'
      : 'Could not fetch a picture from this camera.'

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <Panel as="section">
        <PanelHeader action={<StreamStatusBadge status={status} />}>
          <div className="flex items-center gap-2">
            <CameraIcon className="text-ink-3 size-4 shrink-0" aria-hidden />
            <h2 className="text-ink truncate font-mono text-sm font-medium">{camera.name}</h2>
            <Badge tone={STATUS_TONE[camera.status]}>{camera.status}</Badge>
          </div>
          <p className="text-ink-3 mt-1 truncate font-mono text-xs">
            {camera.stream_url ?? 'No stream URL'}
          </p>
        </PanelHeader>
        <PanelBody flush>
          {/* 16:9, the shape of the fixture frame and of most IP cameras; a
              real frame of another shape letterboxes inside it, and the
              overlay letterboxes identically because both use "meet". */}
          <div className="bg-ink/90 relative aspect-video w-full overflow-hidden">
            {src && !noFrame ? (
              <img
                src={src}
                alt={`Current frame from ${camera.name}`}
                className="absolute inset-0 h-full w-full object-contain"
                onLoad={(e) =>
                  setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                }
              />
            ) : (
              <div className="text-ink-3 absolute inset-0 grid place-items-center p-6 text-center text-sm">
                <div>
                  <ImageOff className="mx-auto mb-2 size-6" aria-hidden />
                  {noFrame ? unavailable : 'Waiting for the first frame…'}
                </div>
              </div>
            )}
            {size && detections.length > 0 && (
              <DetectionOverlay width={size.w} height={size.h} detections={detections} />
            )}
          </div>
        </PanelBody>
      </Panel>

      <Panel as="section">
        <PanelHeader>
          <h2 className="text-ink text-sm font-semibold">Detections</h2>
          <p className="text-ink-3 mt-1 text-xs">
            Weapons, from the live alert stream. Empty is the normal state.
          </p>
        </PanelHeader>
        <PanelBody>
          {detections.length === 0 ? (
            <p className="text-ink-3 text-sm">Nothing flagged on this camera.</p>
          ) : (
            <ul className="space-y-2">
              {detections.map((d, i) => (
                <li
                  key={`${d.class}-${i}`}
                  className="border-danger/30 bg-danger/8 flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="text-ink font-medium">{d.class}</span>
                  <span className="text-ink-2 tabular text-xs">
                    {Math.round(d.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  )
}

/**
 * Boxes in source pixels, on a canvas the size of the source. The <svg> is
 * positioned exactly like the <img> beneath it and shares its object-fit,
 * so a box at [100, 50, 300, 250] lands on the same part of the picture at
 * every window size. Labels sit above the box unless the box starts at the
 * top edge, where they drop inside so they are not clipped.
 */
function DetectionOverlay({
  width,
  height,
  detections,
}: {
  width: number
  height: number
  detections: AlertDetection[]
}) {
  const stroke = Math.max(2, Math.round(width / 320))
  const font = Math.max(12, Math.round(width / 40))
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    >
      {detections.map((d, i) => {
        const [x1, y1, x2, y2] = d.bbox
        const label = `${d.class} ${Math.round(d.confidence * 100)}%`
        const labelY = y1 < font * 1.5 ? y1 + font * 1.2 : y1 - font * 0.4
        return (
          <g key={`${d.class}-${i}`}>
            <rect
              x={x1}
              y={y1}
              width={Math.max(0, x2 - x1)}
              height={Math.max(0, y2 - y1)}
              fill="none"
              stroke="#ff4d4f"
              strokeWidth={stroke}
            />
            <text
              x={x1 + stroke}
              y={labelY}
              fontSize={font}
              fontFamily="system-ui, sans-serif"
              fontWeight={600}
              fill="#ff4d4f"
              stroke="#000"
              strokeWidth={font / 8}
              paintOrder="stroke"
            >
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
