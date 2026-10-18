/**
 * The four shapes every endpoint has to survive.
 *
 * Playbook 6: most integration bugs are empty-state and error-state bugs, so a
 * fixture set that only covers the happy path is not finished. 'large' exists
 * because a list that renders fine with 5 rows can still fall over at 200.
 */
export const MOCK_SCENARIOS = ['normal', 'empty', 'large', 'error'] as const

export type MockScenario = (typeof MOCK_SCENARIOS)[number]

export function isMockScenario(value: string | undefined): value is MockScenario {
  return MOCK_SCENARIOS.includes(value as MockScenario)
}
