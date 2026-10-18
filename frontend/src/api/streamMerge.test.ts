import { describe, expect, it } from 'vitest'
import {
  activeCameras,
  applyAlertFrame,
  applyAlertState,
  mergeStoredAlerts,
  applyOccupancyFrame,
  applyPeopleFrame,
  applyWorkstationFrame,
  INITIAL_PEOPLE_STATE,
  totalAcrossZones,
  unstaffed,
  type AlertsByCamera,
  type WorkstationsByName,
  type ZonesByName,
} from './streamMerge'
import { parseAlertFrame, parseOccupancyFrame, parseWorkstationFrame } from './endpoints/streams'
import type { AlertStateFrame, PeopleStreamFrame, StoredAlert } from './types'

describe('applyAlertFrame', () => {
  it('takes a snapshot as the whole truth', () => {
    const before: AlertsByCamera = {
      'cam-old': [{ class: 'pistol', confidence: 0.9, bbox: [0, 0, 1, 1] }],
    }
    const after = applyAlertFrame(before, { type: 'snapshot', cameras: { 'cam-new': [] } })

    /* The old camera is gone, not merged forward - a snapshot describes every
       camera, so one missing from it no longer exists. */
    expect(Object.keys(after)).toEqual(['cam-new'])
  })

  /* The mistake worth guarding: appending instead of replacing leaves a
     cleared weapon alert on a security screen forever. */
  it('replaces a camera detections rather than appending to them', () => {
    const before: AlertsByCamera = {
      'cam-1': [{ class: 'pistol', confidence: 0.9, bbox: [0, 0, 1, 1] }],
    }
    const after = applyAlertFrame(before, {
      type: 'update',
      camera: 'cam-1',
      detections: [{ class: 'knife', confidence: 0.7, bbox: [2, 2, 3, 3] }],
    })

    expect(after['cam-1']).toHaveLength(1)
    expect(after['cam-1']?.[0]?.class).toBe('knife')
  })

  it('treats an empty detections array as the all-clear', () => {
    const before: AlertsByCamera = {
      'cam-1': [{ class: 'pistol', confidence: 0.9, bbox: [0, 0, 1, 1] }],
    }
    const after = applyAlertFrame(before, { type: 'update', camera: 'cam-1', detections: [] })

    expect(after['cam-1']).toEqual([])
    expect(activeCameras(after)).toEqual([])
  })

  it('leaves other cameras alone', () => {
    const before: AlertsByCamera = {
      'cam-1': [{ class: 'pistol', confidence: 0.9, bbox: [0, 0, 1, 1] }],
      'cam-2': [],
    }
    const after = applyAlertFrame(before, { type: 'update', camera: 'cam-2', detections: [] })

    expect(after['cam-1']).toHaveLength(1)
  })
})

describe('applyOccupancyFrame', () => {
  it('keeps a zone that drops to zero rather than dropping the row', () => {
    const before: ZonesByName = { lobby: { count: 4, points: [[1, 1]] } }
    const after = applyOccupancyFrame(before, {
      type: 'update',
      zone: 'lobby',
      count: 0,
      points: [],
    })

    /* Not just "count is 0" - the key has to survive, or the screen stops
       rendering the row and leaves the last number on a wall display. */
    expect(Object.keys(after)).toContain('lobby')
    expect(after.lobby?.count).toBe(0)
  })

  it('adds a zone it has not seen before', () => {
    const after = applyOccupancyFrame({}, { type: 'update', zone: 'vault', count: 2, points: [] })
    expect(after.vault?.count).toBe(2)
  })

  it('replaces everything on a snapshot', () => {
    const before: ZonesByName = { gone: { count: 9, points: [] } }
    const after = applyOccupancyFrame(before, {
      type: 'snapshot',
      zones: { lobby: { count: 1, points: [] } },
    })
    expect(Object.keys(after)).toEqual(['lobby'])
  })

  /* Overlapping zones double-count on purpose, so the sum is not a headcount
     and nothing in the UI may call it one. */
  it('sums across zones without pretending it is a headcount', () => {
    expect(
      totalAcrossZones({
        lobby: { count: 4, points: [] },
        counters: { count: 3, points: [] },
      }),
    ).toBe(7)
  })
})

describe('frame parsers', () => {
  it('drops unreadable frames instead of throwing', () => {
    expect(parseAlertFrame('not json')).toBeNull()
    expect(parseAlertFrame(42)).toBeNull()
    expect(parseOccupancyFrame('{}')).toBeNull()
  })

  it('accepts a stored-alert state frame, and only with a known event', () => {
    const frame = { ...stateFrame('a1', 'created') }
    expect(parseAlertFrame(JSON.stringify(frame))).toEqual(frame)
    expect(parseAlertFrame(JSON.stringify({ ...frame, event: 'deleted' }))).toBeNull()
  })

  it('rejects a frame whose type is not one of the documented ones', () => {
    expect(parseAlertFrame(JSON.stringify({ type: 'heartbeat' }))).toBeNull()
  })

  it('parses the contract-shaped alert frames', () => {
    const snapshot = parseAlertFrame(JSON.stringify({ type: 'snapshot', cameras: { cam1: [] } }))
    expect(snapshot?.type).toBe('snapshot')

    const update = parseAlertFrame(
      JSON.stringify({
        type: 'update',
        camera: 'cam1',
        detections: [{ class: 'pistol', confidence: 0.87, bbox: [900.5, 332, 1352.5, 664.7] }],
      }),
    )
    expect(update?.type).toBe('update')
  })

  it('parses the contract-shaped occupancy frames', () => {
    const snapshot = parseOccupancyFrame(
      JSON.stringify({ type: 'snapshot', zones: { lobby: { count: 4, points: [[210.5, 533]] } } }),
    )
    expect(snapshot?.type).toBe('snapshot')

    const update = parseOccupancyFrame(
      JSON.stringify({ type: 'update', zone: 'lobby', count: 5, points: [] }),
    )
    expect(update && 'count' in update && update.count).toBe(5)
  })

  /* A count of zero must parse. `typeof 0 === 'number'` is true but a
     truthiness check would drop it, which is exactly the bug that makes an
     emptied zone stay busy on screen. */
  it('parses an occupancy update with a count of zero', () => {
    const frame = parseOccupancyFrame(
      JSON.stringify({ type: 'update', zone: 'lobby', count: 0, points: [] }),
    )
    expect(frame).not.toBeNull()
  })
})

describe('applyWorkstationFrame', () => {
  const desk = {
    name: 'guichet-3',
    zone: 'counters',
    status: 'present' as const,
    since: 1_787_600_000,
    zone_known: true,
  }

  it('replaces everything on a snapshot, including rows that have gone', () => {
    const current: WorkstationsByName = { 'guichet-9': { ...desk, name: 'guichet-9' } }
    const next = applyWorkstationFrame(current, { type: 'snapshot', workstations: [desk] })

    expect(Object.keys(next)).toEqual(['guichet-3'])
  })

  /* An update frame IS a row, not a row inside a payload. Leaving `type` on
     the stored object would put a field in state that no row ever carries. */
  it('folds an update in without keeping the discriminant', () => {
    const next = applyWorkstationFrame(
      { 'guichet-3': desk },
      { type: 'update', ...desk, status: 'away', since: 1_787_600_600 },
    )

    expect(next['guichet-3']).toEqual({ ...desk, status: 'away', since: 1_787_600_600 })
    expect('type' in next['guichet-3']).toBe(false)
  })

  /* `unknown` is not a quiet counter - it is an unclassified one, and
     counting it as empty would pad the number a manager acts on. */
  it('counts only the away ones as unstaffed', () => {
    const state: WorkstationsByName = {
      a: { ...desk, name: 'a', status: 'away' },
      b: { ...desk, name: 'b', status: 'present' },
      c: { ...desk, name: 'c', status: 'unknown', zone_known: false },
    }

    expect(unstaffed(state).map((station) => station.name)).toEqual(['a'])
  })

  it('parses the contract-shaped workstation frames', () => {
    const snapshot = parseWorkstationFrame(
      JSON.stringify({ type: 'snapshot', workstations: [desk] }),
    )
    expect(snapshot?.type).toBe('snapshot')

    const update = parseWorkstationFrame(JSON.stringify({ type: 'update', ...desk }))
    expect(update && 'name' in update && update.name).toBe('guichet-3')

    /* A snapshot with no workstations is a real state: nothing bound yet. */
    expect(
      parseWorkstationFrame(JSON.stringify({ type: 'snapshot', workstations: [] })),
    ).not.toBeNull()
  })
})

function stored(id: string, overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id,
    agency_id: 'casa',
    camera_id: 'cam-1',
    camera_name: 'cam-counter',
    alert_type: 'weapon',
    severity: 'CRITICAL',
    status: 'OPEN',
    created_at: '2026-10-06T10:00:00+00:00',
    resolved_at: null,
    ...overrides,
  }
}

function stateFrame(
  id: string,
  event: AlertStateFrame['event'],
  overrides: Partial<StoredAlert> = {},
): AlertStateFrame {
  return { ...stored(id, overrides), type: 'alert_state', event }
}

describe('stored alerts', () => {
  it('leaves the live detections alone when a state frame arrives', () => {
    const cameras: AlertsByCamera = { cam1: [] }
    expect(applyAlertFrame(cameras, stateFrame('a1', 'created'))).toBe(cameras)
  })

  it('keeps the latest pushed state per alert', () => {
    let pushed = applyAlertState({}, stateFrame('a1', 'created'))
    pushed = applyAlertState(
      pushed,
      stateFrame('a1', 'resolved', {
        status: 'RESOLVED',
        resolved_at: '2026-10-06T10:02:00+00:00',
      }),
    )
    expect(Object.keys(pushed)).toEqual(['a1'])
    expect(pushed.a1?.status).toBe('RESOLVED')
  })

  /* A refetch can land after a socket that missed the resolve while it was
     reconnecting: the resolved copy must not be reopened by the stale push. */
  it('never reopens an alert the fetch already has as resolved', () => {
    const fetched = [stored('a1', { status: 'RESOLVED', resolved_at: '2026-10-06T10:02:00+00:00' })]
    const pushed = applyAlertState({}, stateFrame('a1', 'created'))
    expect(mergeStoredAlerts(fetched, pushed, 'casa', 'weapon')[0]?.status).toBe('RESOLVED')
  })

  it('keeps to one agency and one type, newest first', () => {
    const fetched = [
      stored('old', { created_at: '2026-10-05T09:00:00+00:00' }),
      stored('rabat', { agency_id: 'rabat' }),
      stored('fire', { alert_type: 'fire' }),
    ]
    const pushed = applyAlertState(
      {},
      stateFrame('new', 'created', { created_at: '2026-10-06T11:00:00+00:00' }),
    )
    expect(mergeStoredAlerts(fetched, pushed, 'casa', 'weapon').map((a) => a.id)).toEqual([
      'new',
      'old',
    ])
  })
})

describe('applyPeopleFrame', () => {
  /* A state frame missing fields used to put undefined into state, and the
     live map crashed calling .toFixed() on it - a blank page. */
  it('defaults missing fields of a state frame instead of storing undefined', () => {
    const next = applyPeopleFrame(INITIAL_PEOPLE_STATE, {
      type: 'state',
      phase: 'running',
    } as unknown as PeopleStreamFrame)
    expect(next.phase).toBe('running')
    expect(next.personScale).toBeNull()
    expect(next.room).toBeNull()
    expect(next.error).toBeNull()
    expect(next.warnings).toEqual([])
  })
})

describe('applyPeopleFrame track ids', () => {
  /* The live map labels dots by looking ids up in string-keyed maps; the AI
     sends numbers, so without this no dot ever got its ticket number. */
  it('turns numeric track ids into strings', () => {
    const next = applyPeopleFrame(INITIAL_PEOPLE_STATE, {
      type: 'tracks',
      tracks: [{ id: 5, x: 1, y: 2, hits: 3, misses: 0 }],
    } as unknown as PeopleStreamFrame)
    expect(next.tracks[0].id).toBe('5')
    expect(new Map([['5', 'VIR-001']]).get(next.tracks[0].id)).toBe('VIR-001')
  })
})
