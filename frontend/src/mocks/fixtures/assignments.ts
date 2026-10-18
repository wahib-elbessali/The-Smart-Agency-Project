import { registerMock, registerMockWriter } from '../registry'
import type { AgentAssignment, AgentSummary } from '@/api/types'
import { requestUser } from '../currentUser'
import { assignAgent, getMyAssignment, listAgentSummaries } from '../assignmentStore'

/**
 * Real backend now, see api/endpoints/assignments.ts and
 * backend/app/api/assignments.py - this fixture is the VITE_USE_MOCKS
 * fallback, not the only path.
 *
 * `empty` always answers null regardless of who is asking, unlike `normal`:
 * it exists so the unassigned state (AgentQueue's "ask your manager") is
 * previewable through the scenario switcher, not just by signing in as an
 * agent nobody has assigned yet.
 */
registerMock<AgentAssignment | null>('GET /api/agents/me/assignment', {
  normal: () => {
    const user = requestUser()
    return user ? getMyAssignment(user.id) : null
  },
  empty: () => null,
  large: () => {
    const user = requestUser()
    return user ? getMyAssignment(user.id) : null
  },
})

/** For /api/agencies/{agency_id}/agents - the id is second-to-last segment. */
function agencyIdFrom(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

registerMock<AgentSummary[]>('GET /api/agencies/{id}/agents', {
  normal: (path) => listAgentSummaries(agencyIdFrom(path)),
  empty: () => [],
  large: (path) => listAgentSummaries(agencyIdFrom(path)),
})

/** For /api/agents/{user_id}/assignment - same shape, the id is penultimate. */
function userIdFrom(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

registerMockWriter('PATCH /api/agents/{id}/assignment', (body, path) =>
  assignAgent(userIdFrom(path), (body as { counter_id: string | null }).counter_id),
)
