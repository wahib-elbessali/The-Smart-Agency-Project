import { describe, expect, it } from 'vitest'
import type { AttendanceEntry } from '@/api/attendanceMerge'
import { arrivalsByHalfHour, busiestIndex, headcountSeries, methodMix } from './presenceSeries'

/**
 * These series drive three charts, and a chart is the one place a wrong number
 * does not look wrong - a bar is just slightly taller than it should be and
 * nobody can tell by looking. So the arithmetic is pinned here rather than
 * eyeballed on screen.
 *
 * Times are built as local-time ISO strings without a zone, because the
 * bucketing works in local time: the agency opens at 08:30 wherever it is, not
 * at 08:30 UTC.
 */

function entry(checkIn: string, checkOut: string | null = null, method = 'RFID'): AttendanceEntry {
  return {
    employee_id: `e-${checkIn}-${method}`,
    employee_name: 'Test Person',
    agency_id: 'a-1',
    check_in: `2026-08-16T${checkIn}:00`,
    check_out: checkOut ? `2026-08-16T${checkOut}:00` : null,
    method,
  }
}

describe('arrivalsByHalfHour', () => {
  it('groups check-ins into half-hour buckets', () => {
    const buckets = arrivalsByHalfHour([entry('08:05'), entry('08:20'), entry('08:44')])

    expect(buckets).toEqual([
      { label: '08:00', value: 2 },
      { label: '08:30', value: 1 },
    ])
  })

  it('keeps empty buckets between the first and last arrival', () => {
    // A gap is information - it says nobody arrived - and dropping it would
    // put 09:30 immediately after 08:00 and compress the morning.
    const buckets = arrivalsByHalfHour([entry('08:10'), entry('09:40')])

    expect(buckets.map((b) => b.label)).toEqual(['08:00', '08:30', '09:00', '09:30'])
    expect(buckets.map((b) => b.value)).toEqual([1, 0, 0, 1])
  })

  it('does not pad out to the whole day', () => {
    const buckets = arrivalsByHalfHour([entry('08:10'), entry('08:40')])
    expect(buckets).toHaveLength(2)
  })

  it('returns nothing for no entries', () => {
    expect(arrivalsByHalfHour([])).toEqual([])
  })

  it('ignores an unparseable timestamp rather than bucketing it as midnight', () => {
    const broken = { ...entry('08:10'), check_in: 'not-a-date' }
    const buckets = arrivalsByHalfHour([entry('08:10'), broken])

    expect(buckets).toEqual([{ label: '08:00', value: 1 }])
  })
})

describe('busiestIndex', () => {
  it('points at the tallest bucket', () => {
    expect(
      busiestIndex([
        { label: 'a', value: 1 },
        { label: 'b', value: 5 },
        { label: 'c', value: 2 },
      ]),
    ).toBe(1)
  })

  it('keeps the earliest on a tie, so the marker does not jump between equals', () => {
    expect(
      busiestIndex([
        { label: 'a', value: 3 },
        { label: 'b', value: 3 },
      ]),
    ).toBe(0)
  })

  it('is undefined with nothing to point at', () => {
    expect(busiestIndex([])).toBeUndefined()
  })
})

describe('headcountSeries', () => {
  it('counts someone from check-in until check-out, not for the whole day', () => {
    // In at 08:00, out at 09:00. At 09:00 they have left, so the 09:00 step is
    // zero - a half-open interval, the same rule the roster table uses.
    const series = headcountSeries([entry('08:00', '09:00')])

    expect(series[0]).toBe(1) // 08:00
    expect(series[1]).toBe(1) // 08:30
    expect(series[2]).toBe(0) // 09:00
  })

  it('keeps someone with no check-out counted to the end', () => {
    const series = headcountSeries([entry('08:00', null)])
    expect(series.at(-1)).toBe(1)
  })

  it('adds up overlapping people', () => {
    const series = headcountSeries([
      entry('08:00', null),
      entry('08:00', null),
      entry('08:30', null),
    ])

    expect(series[0]).toBe(2)
    expect(series[1]).toBe(3)
  })

  it('returns nothing for no entries', () => {
    expect(headcountSeries([])).toEqual([])
  })
})

describe('methodMix', () => {
  it('counts each reader method', () => {
    const mix = methodMix([
      entry('08:00', null, 'RFID'),
      entry('08:10', null, 'RFID'),
      entry('08:20', null, 'FACE_RECOGNITION'),
    ])

    expect(mix).toEqual([
      { label: 'RFID', value: 2 },
      { label: 'Face Recognition', value: 1 },
    ])
  })

  it('leaves initialisms alone instead of title-casing them into typos', () => {
    // "Rfid" looks like a mistake, not a hardware standard.
    const [first] = methodMix([entry('08:00', null, 'RFID')])
    expect(first.label).toBe('RFID')
  })

  it('sorts largest first, so the donut reads clockwise by size', () => {
    const mix = methodMix([
      entry('08:00', null, 'FACE_RECOGNITION'),
      entry('08:10', null, 'RFID'),
      entry('08:20', null, 'RFID'),
    ])

    expect(mix.map((m) => m.label)).toEqual(['RFID', 'Face Recognition'])
  })
})
