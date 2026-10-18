import { MOCK_SCENARIO } from '@/api/config'
import type { SocketStream, StreamStatus } from '@/api/socketStream'
import type {
  AlertFeature,
  AlertFrame,
  AlertStateFrame,
  OccupancyFrame,
  PeopleStreamFrame,
  WorkstationFrame,
} from '@/api/types'
import * as alertStore from './alertStore'
import { findCameraByName, getWeaponThreshold } from './cameraStore'
import { getPeopleTracks } from './peopleStore'

/**
 * Fake alerts and occupancy sockets for mock mode.
 *
 * Both mirror the semantics documented in contracts/ai-service.md rather than
 * inventing a convenient rhythm, because the semantics are the part most
 * likely to be got wrong:
 *
 * - Alerts fire only when a camera's **set of detected classes** changes.
 *   Confidence jitter alone sends nothing, and `detections: []` is the
 *   all-clear. A screen built against a steady drip of frames will misread a
 *   quiet period as a dead feed.
 * - Occupancy pushes only when a zone's **count** changes. No heartbeat.
 *
 * So the scripts below include the awkward cases: an alert that clears and
 * comes back, a wanted detection carrying a face photo, and a zone that drops
 * to zero.
 */

/**
 * Frames arrive on a timer so the screens can be watched behaving over time.
 *
 * Under test that pacing is pure cost: a three-frame script at five seconds
 * apart outlasts Vitest's default timeout before the interesting frame lands.
 * The mock layer is development scaffolding, so it is allowed to know it is
 * being tested; the alternative is either a slow suite or timings too fast to
 * watch in a browser.
 */
const UNDER_TEST = import.meta.env.MODE === 'test'
const FIRST_FRAME_MS = UNDER_TEST ? 10 : 1_500
const INTERVAL_MS = UNDER_TEST ? 60 : 5_000

/* A 1x1 transparent PNG. Stands in for the base64 JPEG the wanted feed sends,
   so the screen can prove it renders one without shipping a picture of a
   person into the repository. */
const FAKE_SNAPSHOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function alertScript(feature: AlertFeature): AlertFrame[] {
  if (feature === 'wanted') {
    return [
      { type: 'snapshot', cameras: { 'cam-lobby': [], 'cam-counter': [] } },
      {
        type: 'update',
        camera: 'cam-lobby',
        detections: [
          {
            class: 'MAROUANE-B-2024-114',
            /* Cosine similarity, not a probability - the screen must not
               render this as a percentage. */
            confidence: 0.612,
            bbox: [412, 88, 501, 205],
            det_score: 0.881,
            face_px: 94,
            snapshot: FAKE_SNAPSHOT,
          },
        ],
      },
      /* The all-clear. */
      { type: 'update', camera: 'cam-lobby', detections: [] },
    ]
  }

  if (feature === 'fire') {
    return [
      { type: 'snapshot', cameras: { 'cam-lobby': [], 'cam-store': [] } },
      {
        type: 'update',
        camera: 'cam-store',
        detections: [{ class: 'smoke', confidence: 0.74, bbox: [120, 300, 460, 700] }],
      },
    ]
  }

  if (feature === 'emotion') {
    return [
      { type: 'snapshot', cameras: { 'cam-counter': [] } },
      {
        type: 'update',
        camera: 'cam-counter',
        detections: [{ class: 'angry', confidence: 0.66, bbox: [300, 210, 420, 360] }],
      },
      { type: 'update', camera: 'cam-counter', detections: [] },
    ]
  }

  /* weapon: spread across all three cameras, with confidences on both sides
     of any threshold someone is likely to try (0.6 by default, 0.9 when
     tightened), so the Alerts screen's threshold filter has something to show
     AND something to hide whichever way it is set. Only the two classes the
     feature alerts on (pistol, knife - ai-service.md), and every update
     changes that camera's set of classes, since nothing else sends one.

     It ends with a 91% knife still up on cam-store and an 83% pistol on
     cam-counter: at 0.9 the screen settles on one shown and one hidden rather
     than going blank once the script runs out. cam-lobby never carries a
     pistol and ends clear - CameraView.test relies on both. */
  return [
    { type: 'snapshot', cameras: { 'cam-lobby': [], 'cam-counter': [], 'cam-store': [] } },
    {
      type: 'update',
      camera: 'cam-counter',
      detections: [{ class: 'pistol', confidence: 0.87, bbox: [900, 332, 1352, 664] }],
    },
    {
      type: 'update',
      camera: 'cam-lobby',
      detections: [{ class: 'knife', confidence: 0.94, bbox: [610, 410, 700, 560] }],
    },
    /* A repeated alert later on means the situation genuinely changed and
       changed back - not a duplicate to be swallowed. */
    { type: 'update', camera: 'cam-counter', detections: [] },
    {
      type: 'update',
      camera: 'cam-store',
      detections: [{ class: 'pistol', confidence: 0.96, bbox: [420, 280, 690, 520] }],
    },
    /* Two at once, either side of 0.9: a tightened threshold hides half of it. */
    {
      type: 'update',
      camera: 'cam-counter',
      detections: [
        { class: 'pistol', confidence: 0.92, bbox: [880, 320, 1330, 650] },
        { class: 'knife', confidence: 0.58, bbox: [1400, 500, 1480, 640] },
      ],
    },
    { type: 'update', camera: 'cam-lobby', detections: [] },
    {
      type: 'update',
      camera: 'cam-store',
      detections: [
        { class: 'pistol', confidence: 0.96, bbox: [420, 280, 690, 520] },
        { class: 'knife', confidence: 0.71, bbox: [760, 300, 840, 470] },
      ],
    },
    {
      type: 'update',
      camera: 'cam-counter',
      detections: [{ class: 'pistol', confidence: 0.83, bbox: [880, 320, 1330, 650] }],
    },
    {
      type: 'update',
      camera: 'cam-store',
      detections: [{ class: 'knife', confidence: 0.91, bbox: [760, 300, 840, 470] }],
    },
  ]
}

function occupancyScript(): OccupancyFrame[] {
  return [
    {
      type: 'snapshot',
      zones: {
        lobby: {
          count: 4,
          points: [
            [210.5, 533],
            [260, 540],
            [300, 512],
            [180, 498],
          ],
        },
        counters: {
          count: 2,
          points: [
            [620, 300],
            [660, 310],
          ],
        },
        /* Empty from the start: a zone with nobody in it is normal, not a
           missing zone, and the screen has to show it as zero rather than
           omitting the row. */
        vault: { count: 0, points: [] },
      },
    },
    {
      type: 'update',
      zone: 'lobby',
      count: 5,
      points: [
        [210.5, 533],
        [260, 540],
        [300, 512],
        [180, 498],
        [240, 470],
      ],
    },
    {
      type: 'update',
      zone: 'counters',
      count: 3,
      points: [
        [620, 300],
        [660, 310],
        [700, 295],
      ],
    },
    /* Back to zero - the case where a naive "only render non-empty" screen
       leaves a stale count on the wall. */
    { type: 'update', zone: 'lobby', count: 0, points: [] },
  ]
}

/**
 * Workstation statuses, on the same only-on-change rule as the other two.
 *
 * The script is built around the two readings that are easy to get wrong:
 *
 * - `coffre` never leaves `unknown`, with `zone_known: false`. Its zone is on
 *   the Rabat camera, which is OFFLINE and has never produced a frame, so
 *   nothing has ever been measured there. A screen that renders that as "away"
 *   is reporting an empty counter when what it has is a broken camera.
 * - `accueil` is already empty on connect, and stays that way: the reception
 *   desk nobody is at. It matches workstationStore's seed so the list and the
 *   feed agree from the first frame instead of flipping under the reader.
 * - `guichet-3` goes away and comes back. `away` only arrives after the
 *   service's full absence window (300s by default), so it is a slow, real
 *   signal - not a flicker, and not something to show as instant.
 *
 * `since` is epoch SECONDS, as the contract has it, computed from now so the
 * durations on screen read as minutes rather than as 1970.
 */
function workstationScript(): WorkstationFrame[] {
  const now = Date.now() / 1000

  return [
    {
      type: 'snapshot',
      workstations: [
        { name: 'accueil', zone: 'lobby', status: 'away', since: now - 720, zone_known: true },
        {
          name: 'guichet-3',
          zone: 'counters',
          status: 'present',
          since: now - 2_400,
          zone_known: true,
        },
        /* Bound to a zone nothing has ever read. */
        { name: 'coffre', zone: 'vault', status: 'unknown', since: now - 7_200, zone_known: false },
      ],
    },
    {
      type: 'update',
      name: 'guichet-3',
      zone: 'counters',
      status: 'away',
      since: now - 5,
      zone_known: true,
    },
    {
      type: 'update',
      name: 'guichet-3',
      zone: 'counters',
      status: 'present',
      since: now,
      zone_known: true,
    },
  ]
}

/**
 * The backend's half of the weapon socket: after each detection frame, the
 * alert consumer (backend/app/ai_alerts/consumer.py) keeps the detections at
 * or above the weapon threshold, then for that camera
 *   - some left, an alert open   -> "updated"
 *   - some left, none open       -> "created" (CRITICAL, OPEN)
 *   - none left, alerts open     -> each "resolved"
 * and pushes the committed record on the same socket. Worked out when the
 * frame is sent rather than written into the script, so it follows the
 * threshold as it is at that moment - set it to 0.9 on Cameras and fewer
 * alerts open, exactly as against the backend. alertStore is updated too, so
 * a refetch of the history agrees with what was pushed.
 */
let nextAlertId = 0

function weaponAlertStates(frame: AlertFrame): AlertStateFrame[] {
  if (frame.type !== 'update') return []
  const camera = findCameraByName(frame.camera)
  if (!camera) return []

  const minimum = getWeaponThreshold().confidence
  const kept = frame.detections.filter((d) => d.confidence >= minimum)
  const open = alertStore
    .listAlerts(camera.agency_id, 'weapon')
    .filter((a) => a.camera_id === camera.id && a.status !== 'RESOLVED')
  const now = new Date().toISOString()

  let states: AlertStateFrame[]
  if (kept.length > 0) {
    states =
      open.length > 0
        ? open.map((a) => ({ ...a, type: 'alert_state', event: 'updated' }))
        : [
            {
              type: 'alert_state',
              event: 'created',
              id: `e2000000-0000-4000-8000-${String((nextAlertId += 1)).padStart(12, '0')}`,
              agency_id: camera.agency_id,
              camera_id: camera.id,
              camera_name: camera.name,
              alert_type: 'weapon',
              severity: 'CRITICAL',
              status: 'OPEN',
              created_at: now,
              resolved_at: null,
            },
          ]
  } else {
    states = open.map((a) => ({
      ...a,
      type: 'alert_state',
      event: 'resolved',
      status: 'RESOLVED',
      resolved_at: now,
    }))
  }

  states.forEach(alertStore.applyAlertState)
  return states
}

/**
 * `expand` turns one scripted frame into what is actually sent, at the moment
 * it is sent - the weapon feed uses it to add the stored-alert frames above.
 */
function createScriptedStream<T>(frames: T[], expand?: (frame: T) => T[]): SocketStream<T> {
  const eventListeners = new Set<(event: T) => void>()
  const statusListeners = new Set<(status: StreamStatus) => void>()
  const timers: ReturnType<typeof setTimeout>[] = []

  let status: StreamStatus = 'connecting'
  let stopped = false

  function setStatus(next: StreamStatus) {
    if (status === next || stopped) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  /* The 'error' scenario models a socket that never comes up, so the badge and
     the stale-data warning can actually be looked at. */
  if (MOCK_SCENARIO === 'error') {
    status = 'closed'
  } else {
    timers.push(
      setTimeout(() => {
        setStatus('open')
        frames.forEach((frame, i) => {
          timers.push(
            setTimeout(() => {
              for (const sent of [frame, ...(expand?.(frame) ?? [])]) {
                for (const listener of eventListeners) listener(sent)
              }
            }, i * INTERVAL_MS),
          )
        })
      }, FIRST_FRAME_MS),
    )
  }

  return {
    get status() {
      return status
    },
    subscribe(onEvent) {
      eventListeners.add(onEvent)
      return () => eventListeners.delete(onEvent)
    },
    onStatusChange(listener) {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    close() {
      stopped = true
      timers.forEach(clearTimeout)
      timers.length = 0
      eventListeners.clear()
      statusListeners.clear()
    },
  }
}

export function createMockAlertStream(feature: AlertFeature): SocketStream<AlertFrame> {
  return createScriptedStream(
    alertScript(feature),
    feature === 'weapon' ? weaponAlertStates : undefined,
  )
}

export function createMockOccupancyStream(): SocketStream<OccupancyFrame> {
  return createScriptedStream(occupancyScript())
}

export function createMockWorkstationStream(): SocketStream<WorkstationFrame> {
  return createScriptedStream(workstationScript())
}

/**
 * NOT createScriptedStream, on purpose - that helper pre-builds a fixed list
 * of frames up front and only schedules WHEN each one is delivered.
 * `tracks` frames need computing fresh at send time instead: a person's
 * position changes almost every cycle by construction (see PeopleStreamFrame's
 * own doc comment on why this stream sends a full snapshot every cycle
 * rather than a diff), so pre-computing them all at stream-creation time
 * would freeze every "tick" to the same instant. The snapshot -> bootstrapping
 * -> running sequence before it is a one-time transition, so that part stays
 * a small fixed script, same convention as the other streams here.
 */
export function createMockPeopleStream(): SocketStream<PeopleStreamFrame> {
  const eventListeners = new Set<(event: PeopleStreamFrame) => void>()
  const statusListeners = new Set<(status: StreamStatus) => void>()
  const timers: ReturnType<typeof setTimeout>[] = []
  let interval: ReturnType<typeof setInterval> | null = null

  let status: StreamStatus = 'connecting'
  let stopped = false

  function setStatus(next: StreamStatus) {
    if (status === next || stopped) return
    status = next
    for (const listener of statusListeners) listener(next)
  }
  function emit(frame: PeopleStreamFrame) {
    for (const listener of eventListeners) listener(frame)
  }

  if (MOCK_SCENARIO === 'error') {
    status = 'closed'
  } else {
    timers.push(
      setTimeout(() => {
        setStatus('open')
        emit({ type: 'snapshot', state: 'idle', tracks: [] })
        timers.push(
          setTimeout(() => {
            emit({
              type: 'state',
              phase: 'bootstrapping',
              warnings: [],
              error: null,
              person_scale: null,
              room: null,
              fps: null,
              cams_bootstrapped: null,
              gates_loaded: null,
            })
          }, INTERVAL_MS),
        )
        timers.push(
          setTimeout(() => {
            emit({
              type: 'state',
              phase: 'running',
              warnings: [],
              error: null,
              person_scale: 1.72,
              room: { xmin: -1, xmax: 11, ymin: -1, ymax: 7 },
              fps: 7.5,
              cams_bootstrapped: [],
              gates_loaded: 0,
            })
            /* Only starts ticking once "running" - a track frame before that
               would contradict the phase this same stream just announced. */
            interval = setInterval(() => {
              emit({ type: 'tracks', tracks: getPeopleTracks(), boxes: {} })
            }, INTERVAL_MS)
          }, INTERVAL_MS * 2),
        )
      }, FIRST_FRAME_MS),
    )
  }

  return {
    get status() {
      return status
    },
    subscribe(onEvent) {
      eventListeners.add(onEvent)
      return () => eventListeners.delete(onEvent)
    },
    onStatusChange(listener) {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    close() {
      stopped = true
      timers.forEach(clearTimeout)
      timers.length = 0
      if (interval !== null) clearInterval(interval)
      eventListeners.clear()
      statusListeners.clear()
    },
  }
}
