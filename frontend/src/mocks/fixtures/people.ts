import type { Employee } from '@/api/types'

/**
 * One roster, shared by the employees and attendance fixtures.
 *
 * They have to agree: an attendance record naming someone who isn't in the
 * employee list is a bug the real backend would never produce, and a fixture
 * set that can't happen in production teaches the UI to handle a case that
 * doesn't exist while hiding one that does.
 *
 * Every field name here comes from GET /api/employees in contracts/api.md.
 * The VALUES are invented - that is what a fixture is - but no field is.
 */

export const AGENCY_ID = 'a1000000-0000-4000-8000-000000000001'
export const AGENCY_ID_RABAT = 'a1000000-0000-4000-8000-000000000002'

interface Seed {
  first: string
  last: string
  position: string
}

const SEEDS: Seed[] = [
  { first: 'Hamza', last: 'Benali', position: "Agent d'accueil" },
  { first: 'Leila', last: 'Fassi', position: 'Responsable de guichet' },
  { first: 'Youssef', last: 'El Amrani', position: 'Conseiller clientèle' },
  { first: 'Salma', last: 'Bennani', position: 'Chargée de conformité' },
  { first: 'Mehdi', last: 'Ouazzani', position: 'Agent de sécurité' },
  { first: 'Nadia', last: 'Cherkaoui', position: 'Conseillère clientèle' },
  { first: 'Karim', last: 'Tazi', position: 'Technicien réseau' },
  { first: 'Imane', last: 'Rachidi', position: 'Chargée de caisse' },
  { first: 'Omar', last: 'Idrissi', position: 'Agent de sécurité' },
  { first: 'Hafsa', last: 'Lamrani', position: "Agent d'accueil" },
]

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * Index 7 deliberately has no position and no RFID card.
 *
 * EmployeeResponse marks position, rfid_uid, email, phone and hire_date
 * optional, and the contract's example shows all of them populated. A fixture
 * set where they are always filled in teaches the table a guarantee the API
 * does not make - and "null" rendering into a cell on a wall display is exactly
 * the failure this catches.
 */
const INCOMPLETE_RECORD_INDEX = 7

export function makeEmployee(index: number, agencyId = AGENCY_ID): Employee {
  const seed = SEEDS[index % SEEDS.length]
  const suffix = index >= SEEDS.length ? ` ${Math.floor(index / SEEDS.length) + 1}` : ''
  const last = `${seed.last}${suffix}`

  return {
    id: uuid('e1000000', index + 1),
    agency_id: agencyId,
    first_name: seed.first,
    last_name: last,
    email: `${seed.first}.${last}`.toLowerCase().replace(/\s+/g, '') + '@agency.com',
    phone: `06${String(12345678 + index).slice(0, 8)}`,
    position: index === INCOMPLETE_RECORD_INDEX ? null : seed.position,
    rfid_uid:
      index === INCOMPLETE_RECORD_INDEX ? null : `RFID-${String(index + 1).padStart(3, '0')}`,
    status: 'ACTIVE',
    hire_date: '2026-08-01',
    authorized_zone_ids: [],
    is_active: true,
  }
}

export function makeEmployees(count: number, agencyId = AGENCY_ID): Employee[] {
  return Array.from({ length: count }, (_, i) => makeEmployee(i, agencyId))
}

export function fullNameOf(employee: Employee): string {
  return `${employee.first_name} ${employee.last_name}`
}
