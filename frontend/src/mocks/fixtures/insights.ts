import { registerMock } from '../registry'
import type {
  AccessFailureInsights,
  AgencyReport,
  BranchOverview,
  DeviceUptimeInsights,
  InsightsOverview,
  ReportRollup,
  SatisfactionInsights,
  TrendInsights,
} from '@/api/types'
import { DEVICE_ID_DHT22, DEVICE_ID_PIR } from '../deviceStore'
import { SERVICE_ID_OUV, SERVICE_ID_VIR } from '../serviceStore'
import { AGENCY_ID, AGENCY_ID_RABAT } from './people'

/**
 * Insights and reports had no fixtures (2026-10-18 review). One believable
 * branch day, built from the same shapes contracts/api.md documents, so the
 * screens render something real in mock mode. Numbers are illustrative.
 */

const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

const satisfaction: SatisfactionInsights = {
  window_hours: 24,
  total_samples: 120,
  counts_by_emotion: { Happy: 54, Neutral: 48, Sad: 10, Angry: 8 },
  positive_pct: 45,
  neutral_pct: 40,
  negative_pct: 15,
}

function overview(scale = 1): InsightsOverview {
  return {
    alerts: { open_by_severity: { CRITICAL: 1, HIGH: 0, MEDIUM: 2, LOW: 0 }, open_total: 3 },
    tickets: { waiting: 4 * scale, in_service: 2, completed_today: 37 * scale, cancelled_today: 2 },
    satisfaction,
    wait_times: {
      window_hours: 24,
      sample_count: 37 * scale,
      avg_queue_wait_seconds: 412,
      avg_walk_over_seconds: 38,
      avg_service_duration_seconds: 305,
      avg_total_seconds: 755,
    },
    visitor_recognition: {
      window_days: 30,
      new_visitors: 210 * scale,
      returning_visitors: 64 * scale,
      returning_pct: 23.4,
      avg_days_between_visits: 9.5,
    },
    service_satisfaction: { ...satisfaction, tickets_with_coverage: 22 * scale },
  }
}

const trends: TrendInsights = {
  days: 7,
  opening_seconds_per_day: 8.5 * 3600,
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: day(6 - i),
    tickets_completed: 30 + ((i * 7) % 15),
    avg_service_seconds: 280 + i * 6,
    service_samples: 30 + i,
    alerts_opened: i % 3,
    critical_alerts_opened: i === 4 ? 1 : 0,
    satisfaction_samples: 100 + i * 5,
    positive_pct: 42 + i,
    negative_pct: 16 - i,
  })),
  counters: [
    {
      counter_id: 'k1000000-0000-4000-8000-000000000001',
      number: 1,
      name: 'Guichet 1',
      tickets_completed: 140,
      avg_service_seconds: 290,
      service_samples: 140,
      busy_seconds: 40_600,
      utilization_pct: 66,
    },
    {
      counter_id: 'k1000000-0000-4000-8000-000000000002',
      number: 2,
      name: 'Guichet 2',
      tickets_completed: 98,
      avg_service_seconds: 335,
      service_samples: 98,
      busy_seconds: 32_800,
      utilization_pct: 54,
    },
  ],
  services: [
    {
      service_id: SERVICE_ID_VIR,
      name: 'Virement',
      tickets_completed: 160,
      avg_queue_wait_seconds: 380,
      avg_service_seconds: 270,
      service_samples: 160,
      is_slowest: false,
    },
    {
      service_id: SERVICE_ID_OUV,
      name: 'Ouverture de compte',
      tickets_completed: 78,
      avg_queue_wait_seconds: 510,
      avg_service_seconds: 610,
      service_samples: 78,
      is_slowest: true,
    },
  ],
}

const deviceUptime: DeviceUptimeInsights = {
  days: 7,
  devices: [
    {
      device_id: DEVICE_ID_DHT22,
      name: 'Capteur salle',
      device_type: 'SENSOR',
      heartbeat_seconds: 30,
      currently_online: true,
      last_seen_at: new Date().toISOString(),
      samples: 2016,
      online_pct: 99.2,
      flaps: 1,
      tracking_since: day(30),
      daily: [],
    },
  ],
  untracked: [{ device_id: DEVICE_ID_PIR, name: 'Detecteur PIR', device_type: 'SENSOR' }],
}

const accessFailures: AccessFailureInsights = {
  window_minutes: 10,
  threshold: 5,
  doors: [
    {
      device_id: DEVICE_ID_PIR,
      name: 'Access sensors 1',
      failures_in_window: 2,
      failures_24h: 6,
      distinct_cards_in_window: 2,
      by_reason: { not_authorized: 4, face_mismatch: 1, unknown_badge: 1 },
      last_failure_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      flagged: false,
      recent: [],
    },
  ],
}

function report(agencyId: string, name: string, scale = 1): AgencyReport {
  const o = overview(scale)
  return {
    agency_id: agencyId,
    name,
    period: { start: day(7), end: day(0), days: 7 },
    generated_at: new Date().toISOString(),
    tickets: {
      created: 260 * scale,
      completed: 238 * scale,
      cancelled: 9,
      no_show: 13,
      unfinished: 0,
      completion_pct: 91.5,
      visitors_served: 221 * scale,
    },
    wait_times: o.wait_times,
    satisfaction,
    service_satisfaction: o.service_satisfaction,
    alerts: {
      opened_total: 11,
      opened_by_severity: { CRITICAL: 2, HIGH: 1, MEDIUM: 8 },
      opened_by_type: { temperature: 6, weapon: 1, intrusion: 1, ai_service_down: 1, gas_co: 2 },
      resolved: 11,
      avg_resolve_minutes: 14.2,
    },
    busiest: { day: day(3), day_tickets: 47, hour_utc: 10, hour_tickets: 12 },
    trends,
  }
}

registerMock<InsightsOverview>('GET /api/agencies/{id}/insights/overview', {
  normal: () => overview(),
  empty: () => overview(0),
  large: () => overview(4),
})
registerMock<SatisfactionInsights>('GET /api/agencies/{id}/insights/satisfaction', {
  normal: () => satisfaction,
  empty: () => ({
    ...satisfaction,
    total_samples: 0,
    counts_by_emotion: {},
    positive_pct: null,
    neutral_pct: null,
    negative_pct: null,
  }),
  large: () => satisfaction,
})
registerMock<TrendInsights>('GET /api/agencies/{id}/insights/trends', {
  normal: () => trends,
  empty: () => ({ ...trends, daily: [], counters: [], services: [] }),
  large: () => trends,
})
registerMock<DeviceUptimeInsights>('GET /api/agencies/{id}/insights/devices', {
  normal: () => deviceUptime,
  empty: () => ({ days: 7, devices: [], untracked: [] }),
  large: () => deviceUptime,
})
registerMock<AccessFailureInsights>('GET /api/agencies/{id}/insights/access', {
  normal: () => accessFailures,
  empty: () => ({ ...accessFailures, doors: [] }),
  large: () => accessFailures,
})
registerMock<BranchOverview[]>('GET /api/insights/branches', {
  normal: () => [
    { agency_id: AGENCY_ID, name: 'Agence Casablanca', is_active: true, overview: overview() },
    { agency_id: AGENCY_ID_RABAT, name: 'Agence Rabat', is_active: true, overview: overview(2) },
  ],
  empty: () => [],
  large: () => [],
})
registerMock<AgencyReport>('GET /api/agencies/{id}/report', {
  normal: (path) =>
    report(new URL(path, 'http://mock').pathname.split('/')[3] ?? AGENCY_ID, 'Agence Casablanca'),
  empty: () => report(AGENCY_ID, 'Agence Casablanca', 0),
  large: () => report(AGENCY_ID, 'Agence Casablanca', 4),
})
registerMock<ReportRollup>('GET /api/reports/branches', {
  normal: () => {
    const branches = [
      report(AGENCY_ID, 'Agence Casablanca'),
      report(AGENCY_ID_RABAT, 'Agence Rabat', 2),
    ]
    return { period: branches[0].period, branches, totals: report('', 'Toutes les agences', 3) }
  },
  empty: () => ({
    period: report(AGENCY_ID, '').period,
    branches: [],
    totals: report('', 'Toutes les agences', 0),
  }),
  large: () => ({
    period: report(AGENCY_ID, '').period,
    branches: [],
    totals: report('', 'Toutes les agences', 0),
  }),
})
