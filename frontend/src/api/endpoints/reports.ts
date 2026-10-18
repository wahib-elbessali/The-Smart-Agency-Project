import { fetchJson } from '../client'
import type { AgencyReport, ReportRollup } from '../types'

/**
 * End-of-month reporting: the historical counterpart of the live Insights.
 * Dates are inclusive UTC days (YYYY-MM-DD).
 */

/** One branch over a range. ADMIN, and MANAGER for their own branch. */
export function fetchAgencyReport(
  agencyId: string,
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<AgencyReport> {
  return fetchJson<AgencyReport>(
    {
      key: 'GET /api/agencies/{id}/report',
      path: `/api/agencies/${agencyId}/report?start=${start}&end=${end}`,
      auth: true,
    },
    { signal },
  )
}

/** Every branch over a range, with totals. ADMIN only. */
export function fetchBranchRollup(
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<ReportRollup> {
  return fetchJson<ReportRollup>(
    {
      key: 'GET /api/reports/branches',
      path: `/api/reports/branches?start=${start}&end=${end}`,
      auth: true,
    },
    { signal },
  )
}
