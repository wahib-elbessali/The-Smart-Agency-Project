import { fetchJson } from '../client'
import type {
  AccessFailureInsights,
  BranchOverview,
  DeviceUptimeInsights,
  InsightsOverview,
  SatisfactionInsights,
  TrendInsights,
} from '../types'

/**
 * Read-only aggregation over data the backend already has - no new AI call,
 * no new hardware. contracts/api.md, added 2026-09-23. ADMIN, MANAGER and
 * SECURITY, same bucket as /alerts: a monitoring view, not configuration.
 */

export function fetchInsightsOverview(
  agencyId: string,
  signal?: AbortSignal,
): Promise<InsightsOverview> {
  return fetchJson<InsightsOverview>(
    {
      key: 'GET /api/agencies/{id}/insights/overview',
      path: `/api/agencies/${agencyId}/insights/overview`,
      auth: true,
    },
    { signal },
  )
}

export function fetchSatisfaction(
  agencyId: string,
  hours?: number,
  signal?: AbortSignal,
): Promise<SatisfactionInsights> {
  const query = hours !== undefined ? `?hours=${hours}` : ''
  return fetchJson<SatisfactionInsights>(
    {
      key: 'GET /api/agencies/{id}/insights/satisfaction',
      path: `/api/agencies/${agencyId}/insights/satisfaction${query}`,
      auth: true,
    },
    { signal },
  )
}

/** History for decisions: daily buckets, per-counter utilization, per-service
 * bottleneck. Fetched once per view, not polled - past days do not change. */
export function fetchInsightsTrends(
  agencyId: string,
  days: number,
  signal?: AbortSignal,
): Promise<TrendInsights> {
  return fetchJson<TrendInsights>(
    {
      key: 'GET /api/agencies/{id}/insights/trends',
      path: `/api/agencies/${agencyId}/insights/trends?days=${days}`,
      auth: true,
    },
    { signal },
  )
}

/** Uptime and flapping for devices a manager marked as periodic publishers. */
export function fetchDeviceUptime(
  agencyId: string,
  days: number,
  signal?: AbortSignal,
): Promise<DeviceUptimeInsights> {
  return fetchJson<DeviceUptimeInsights>(
    {
      key: 'GET /api/agencies/{id}/insights/devices',
      path: `/api/agencies/${agencyId}/insights/devices?days=${days}`,
      auth: true,
    },
    { signal },
  )
}

/** Failed badge attempts per door, the per-agency threshold evaluated live. */
export function fetchAccessFailures(
  agencyId: string,
  signal?: AbortSignal,
): Promise<AccessFailureInsights> {
  return fetchJson<AccessFailureInsights>(
    {
      key: 'GET /api/agencies/{id}/insights/access',
      path: `/api/agencies/${agencyId}/insights/access`,
      auth: true,
    },
    { signal },
  )
}

/** Every branch's live overview side by side. ADMIN only. */
export function fetchBranchComparison(signal?: AbortSignal): Promise<BranchOverview[]> {
  return fetchJson<BranchOverview[]>(
    { key: 'GET /api/insights/branches', path: '/api/insights/branches', auth: true },
    { signal },
  )
}
