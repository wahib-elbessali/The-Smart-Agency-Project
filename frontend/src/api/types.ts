/**
 * Types transcribed from contracts/api.md, then corrected against the backend
 * schemas in backend/app/schemas/ and backend/app/models/entities.py.
 *
 * Reading both matters: the contract's examples show every field populated, but
 * the Pydantic response models mark several of them optional. Typing from the
 * examples alone produces types that claim more than the API guarantees.
 *
 * Where an enum's members are enforced by a database Enum column, the union
 * below is exact - the backend cannot emit anything else without a migration.
 * Where the contract showed one example and nothing enforces the rest, the type
 * stays `string`.
 */

/** Enforced by the `roles.name` Enum column. */
export const ROLES = ['ADMIN', 'MANAGER', 'AGENT', 'SECURITY', 'TECHNICIAN'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Enforced by the `employees.status` Enum column. */
export const EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

/**
 * A service point serves one visitor at a time (`COUNTER`) or handles work
 * that does not (`OFFICE`, e.g. a back-office loan review). Enforced by
 * backend/app/schemas/service.py's `PointType` literal, not a database enum -
 * still exact, since nothing else assigns the column.
 */
export const POINT_TYPES = ['COUNTER', 'OFFICE'] as const
export type PointType = (typeof POINT_TYPES)[number]

/** Enforced by the `devices.status` Enum column. */
export const DEVICE_STATUSES = ['ONLINE', 'OFFLINE', 'ERROR', 'MAINTENANCE'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

/**
 * Enforced by the `attendance.method` Enum column.
 *
 * Only RFID is ever written today - record_check_in() hard-codes it. The other
 * two exist in the schema for the facial recognition and manual paths that the
 * project brief calls for but nothing implements yet.
 */
export const ATTENDANCE_METHODS = ['RFID', 'FACE_RECOGNITION', 'MANUAL'] as const
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number]

/** Both are emitted; the MQTT message schema constrains them to this pair. */
export const ATTENDANCE_EVENTS = ['check_in', 'check_out'] as const
export type AttendanceEventKind = (typeof ATTENDANCE_EVENTS)[number]

/**
 * GET /api/auth/me, and the `user` object inside POST /api/auth/login.
 *
 * This is the *small* user shape. `/api/users` returns a larger one - see
 * `UserAccount` below, which is where `employee_id` and `employee` live. The
 * backend calls both models `UserResponse`, which is the trap: they are two
 * types with one name, and this one carries neither field.
 */
export interface User {
  id: string
  full_name: string
  email: string
  role: Role
  /** null for an ADMIN not scoped to one agency. */
  agency_id: string | null
  is_active: boolean
}

/** POST /api/auth/login and POST /api/auth/refresh both return this. */
export interface LoginResponse {
  access_token: string
  refresh_token: string
  /** Contract shows "bearer". Not narrowed - the casing is the backend's call. */
  token_type: string
  user: User
}

/** Nested in AgencyResponse. Shape from backend/app/schemas/agency.py. */
export interface Zone {
  id: string
  name: string
  /** Free text with a "PUBLIC" default, not an enum column. */
  zone_type: string
  is_private: boolean
  /** "rfid": the badge opens it. "rfid_face": badge + the badge holder's face. */
  access_mode?: ZoneAccessMode
  /** The camera that checks faces at this door (needed for rfid_face). */
  door_camera_id?: string | null
}

export type ZoneAccessMode = 'rfid' | 'rfid_face'

/**
 * Nested in AgencyResponse, from backend/app/schemas/agency.py's
 * `CounterResponse`. Added by the services contract update (2026-08-27):
 * `service_id` and `point_type` did not exist before it.
 */
export interface Counter {
  id: string
  number: number
  name: string | null
  point_type: PointType
  is_open: boolean
  /** null until PATCH /api/counters/{id}/service assigns one. */
  service_id: string | null
  /** Optional, manager-configured (set via PUT /api/counters/{id}, no
   * dedicated UI yet) - an emotion sample only counts toward this counter's
   * service-satisfaction reading if it lands within a ticket's
   * in_service_at-completed_at window on this specific camera. */
  emotion_camera_id: string | null
  /** Optional, manager-configured (PUT /api/counters/{id}, no UI yet) - the
   * AI workstation bound to the zone this counter sits in, so the visitor
   * board can show whether anyone is physically at it right now. */
  workstation_name: string | null
}

/** GET|POST /api/agencies. Four fields are optional in AgencyResponse. */
export interface Agency {
  id: string
  name: string
  address: string | null
  phone: string | null
  /** "HH:MM:SS", local to the agency. There is no timezone field anywhere. */
  opening_time: string | null
  closing_time: string | null
  is_active: boolean
  /** Per-agency, manager-configurable - how long an agent must wait after
   * calling a ticket before the no-show skip button unlocks. */
  no_show_min_wait_seconds: number
  /** Which existing zone (by name, drawn on the Zones screen) acts as this
   * agency's kiosk zone for tracking-to-ticket linking. Null until a
   * manager sets one via PUT /api/agencies/{id}. */
  kiosk_zone_name: string | null
  /** The camera that sees faces at the kiosk; null = the kiosk zone's camera. */
  kiosk_face_camera_id?: string | null
  /** Queue signal thresholds - a dashboard-visual signal only, never an alert.
   * null switches that threshold off. Set via PUT /api/agencies/{id}, no UI. */
  queue_depth_warning: number | null
  queue_depth_critical: number | null
  oldest_wait_warning_seconds: number | null
  oldest_wait_critical_seconds: number | null
  /** Per-agency autonomous toggle: when on, a weapon detection that is still present
   * 4 seconds after it first appears also locks every device whose type is DOOR. Off
   * (the default) is notify-only. */
  weapon_lockdown_enabled: boolean
  /** Failed-badge signal, dashboard-only: a door is flagged when it has at
   * least this many failed attempts inside the window. null = off. */
  access_failure_threshold: number | null
  access_failure_window_minutes: number
  zones: Zone[]
  counters: Counter[]
  employees_count: number
  devices_count: number
  cameras_count: number
}

/**
 * POST /api/agencies — nested zone, from the request body in the contract.
 *
 * No `id`: the server assigns it and returns the full Zone. Sent nested in
 * POST /api/agencies, or on its own to POST /api/agencies/{id}/access-zones.
 */
export interface ZoneCreate {
  name: string
  /** Free text with a "PUBLIC" default, matching Zone. */
  zone_type?: string
  is_private?: boolean
  access_mode?: ZoneAccessMode
  door_camera_id?: string | null
}

/** PUT /api/access-zones/{id}. Partial, exclude_unset. */
export type ZoneUpdate = Partial<ZoneCreate>

/**
 * POST /api/agencies — nested counter. `number` must be unique per agency.
 * `point_type` defaults to `COUNTER` server-side when omitted.
 */
export interface CounterCreate {
  number: number
  name?: string | null
  point_type?: PointType
  is_open?: boolean
}

/**
 * PUT /api/counters/{id} — from CounterUpdate. All fields optional and
 * exclude_unset server-side: renaming a counter must not silently reopen
 * one that was deliberately closed. Which service a counter serves moves
 * through its own route (assignCounterService in endpoints/services.ts),
 * not this one.
 */
export interface CounterUpdate {
  number?: number
  name?: string | null
  is_open?: boolean
  emotion_camera_id?: string | null
  workstation_name?: string | null
}

/**
 * POST /api/agencies — the request body.
 *
 * Only `name` is required (2-150 chars). Everything else is optional, including
 * the two nested lists.
 *
 * `is_active` is absent on purpose. The response carries it, but the contract's
 * request body does not list it, and "a field not listed there is not accepted
 * by that endpoint" is the stated convention. A new agency is active; PUT is
 * where that changes.
 */
export interface AgencyCreate {
  name: string
  address?: string | null
  phone?: string | null
  /** "HH:MM:SS". */
  opening_time?: string | null
  closing_time?: string | null
  zones?: ZoneCreate[]
  counters?: CounterCreate[]
}

/**
 * PUT /api/agencies/{id} — from the contract's request body.
 *
 * "All fields are optional; only the fields included in the request are
 * updated", which is the same exclude_unset behaviour the employee route has.
 *
 * `zones` and `counters` are deliberately NOT here. The contract's PUT example
 * shows only scalar fields, and its response echoes the nested lists unchanged.
 * Sending them would be guessing at whether the backend replaces, merges or
 * ignores the list - three very different outcomes, one of which silently
 * destroys every counter in the agency. Editing those needs its own contract
 * entry before it gets a form.
 */
export interface AgencyUpdate {
  name?: string
  address?: string | null
  phone?: string | null
  opening_time?: string | null
  closing_time?: string | null
  is_active?: boolean
  no_show_min_wait_seconds?: number
  kiosk_zone_name?: string | null
  kiosk_face_camera_id?: string | null
  weapon_lockdown_enabled?: boolean
  access_failure_threshold?: number | null
  access_failure_window_minutes?: number
  queue_depth_warning?: number | null
  queue_depth_critical?: number | null
  oldest_wait_warning_seconds?: number | null
  oldest_wait_critical_seconds?: number | null
}

/** GET|POST /api/employees. Five fields are optional in EmployeeResponse. */
export interface Employee {
  id: string
  agency_id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  position: string | null
  rfid_uid: string | null
  status: EmployeeStatus
  /** "YYYY-MM-DD". */
  hire_date: string | null
  is_active: boolean
  /** Door access zones (Zone ids) this employee's badge opens. */
  authorized_zone_ids: string[]
}

/**
 * POST /api/employees — the request body, from EmployeeCreate.
 *
 * Only first_name and last_name are required. `status` defaults to ACTIVE
 * server-side, and `is_active` is derived from it rather than sent - the
 * backend sets is_active = (status === 'ACTIVE'), so exposing both in a form
 * would let them disagree.
 *
 * agency_id is required for an ADMIN (422 without it) and ignored for a
 * MANAGER, who can only ever create inside their own agency.
 */
export interface EmployeeCreate {
  first_name: string
  last_name: string
  email?: string | null
  phone?: string | null
  position?: string | null
  agency_id?: string | null
  rfid_uid?: string | null
  status?: EmployeeStatus
  hire_date?: string | null
  /** Replaces the whole list. Ids must belong to the employee's agency (404 otherwise). */
  authorized_zone_ids?: string[]
}

/**
 * PUT /api/employees/{id} — from EmployeeUpdate.
 *
 * The backend uses `exclude_unset`, so an omitted key is left alone and an
 * explicit null clears the field. That distinction is real: sending
 * `{email: null}` erases the address, sending nothing keeps it.
 *
 * `agency_id` is narrowed to exclude null even though the schema allows it.
 * The column is NOT NULL, so sending null would fail at the database rather
 * than in validation - a 500 dressed as a user error. An employee always
 * belongs to an agency; moving them is a change, not a clearing.
 */
export type EmployeeUpdate = Partial<Omit<EmployeeCreate, 'agency_id'>> & {
  agency_id?: string
}

/**
 * GET|POST /api/agencies/{agency_id}/services and GET|PUT /api/services/{id},
 * from ServiceResponse. What a visitor's ticket is actually for - "Virement",
 * "Ouverture de compte" - and the unit a counter is assigned to serve.
 */
export interface Service {
  id: string
  agency_id: string
  /** Unique per agency, not globally. Normalized upper-case server-side. */
  code: string
  name: string
  description: string | null
  point_type: PointType
  /** How many open points are needed before the service is considered staffed. */
  min_points: number
  is_active: boolean
}

/**
 * POST /api/agencies/{agency_id}/services — from ServiceCreate.
 * `point_type` and `min_points` default server-side (`COUNTER`, `1`); `is_active`
 * defaults to `true`.
 */
export interface ServiceCreate {
  code: string
  name: string
  description?: string | null
  point_type?: PointType
  min_points?: number
  is_active?: boolean
}

/** PUT /api/services/{id} — from ServiceUpdate. All fields optional, exclude_unset. */
export type ServiceUpdate = Partial<ServiceCreate>

/**
 * GET /api/services/{id}/points — from ServicePointResponse. The same row as
 * `Counter`, but flattened with its own `agency_id` rather than inherited from
 * a parent Agency object, because this list is not nested under one.
 */
export interface ServicePoint {
  id: string
  agency_id: string
  service_id: string | null
  number: number
  name: string | null
  point_type: PointType
  is_open: boolean
}

/**
 * PATCH /api/counters/{counter_id}/service — from CounterServiceAssignment.
 * `service_id: null` clears the assignment and resets the counter's
 * `point_type` back to `COUNTER` server-side.
 */
export interface CounterServiceAssignment {
  service_id: string | null
}

/**
 * Backs GET /api/agents/me/assignment - contracts/api.md. Built ahead of the
 * backend (2026-09-05, at the user's direction, back when neither User nor
 * Employee carried a service or counter) so AgentQueue could read which
 * counter a MANAGER put an agent on, instead of asking the agent to pick
 * their own. Real now - backend/app/schemas/assignment.py's
 * AgentAssignmentResponse, same field names. See api/endpoints/assignments.ts.
 */
export interface AgentAssignment {
  counter_id: string
  counter_name: string | null
  service_id: string
  service_name: string
  /** The agency's configured no-show wait - see Agency.no_show_min_wait_seconds. */
  no_show_min_wait_seconds: number
}

/**
 * Backs GET /api/agencies/{id}/agents - contracts/api.md, real now
 * (backend/app/schemas/assignment.py's AgentSummaryResponse). The
 * MANAGER-facing counterpart to AgentAssignment above: one row per AGENT
 * account in the agency, with whatever they're currently assigned to (or
 * null). Deliberately narrower than GET /api/users, which is ADMIN-only
 * (contracts/api.md §5) - a MANAGER can't read that list at all today, so
 * this doesn't loosen it, it's a separate, smaller surface built for exactly
 * this screen. See api/endpoints/assignments.ts.
 */
export interface AgentSummary {
  user_id: string
  full_name: string
  /** AGENT or MANAGER - a manager can cover a counter too. */
  role?: string
  assignment: AgentAssignment | null
  /** Today's badge state. null = the agent has no linked Employee, so there
   * is nothing to check (never a reason to flag them). "unavailable" = the
   * MQTT broker is down, so a missing badge-in proves nothing. */
  attendance: AgentAttendance | null
}

export interface AgentAttendance {
  state: 'checked_in' | 'checked_out' | 'not_checked_in' | 'unavailable'
  /** ISO 8601 - the check-in time, or the check-out time for checked_out. */
  at: string | null
}

/**
 * The employee summary nested in a GET /api/users entry, from
 * EmployeeLinkResponse in backend/app/schemas/user.py.
 *
 * It is NOT an `Employee`: it carries five fields, not eleven. Reusing
 * `Employee` here would claim a `status` and a `hire_date` this payload never
 * sends.
 */
export interface EmployeeLink {
  id: string
  first_name: string
  last_name: string
  agency_id: string
  rfid_uid: string | null
}

/**
 * GET|POST /api/users, and the two PATCH routes.
 *
 * Deliberately a different type from `User` above, even though the backend
 * calls both of them `UserResponse`. `/api/auth/me` returns the smaller one;
 * `/api/users` adds `employee_id` and the nested `employee`. They are two
 * shapes with one name, and typing them as one would let a screen read
 * `.employee` off a payload that never carries it.
 *
 * `agency_id` is null for exactly one reason: the account is an ADMIN. See
 * validate_agency_for_role - an ADMIN must have no agency and every other role
 * must have one, which is the inverse of what you would guess.
 */
export interface UserAccount {
  id: string
  full_name: string
  email: string
  role: Role
  /** null if and only if the role is ADMIN. */
  agency_id: string | null
  employee_id: string | null
  is_active: boolean
  /** null when this login is not tied to a person with a card. */
  employee: EmployeeLink | null
}

/**
 * POST /api/users — the request body, from UserCreate.
 *
 * `password` is required (min 8, max 72) and is **not in contracts/api.md**:
 * the documented payload for this endpoint is the response, which of course
 * never contains it. Verified in backend/app/schemas/user.py.
 *
 * `role` defaults to AGENT server-side. `agency_id` is required for every role
 * except ADMIN, which must not have one.
 */
export interface UserCreate {
  full_name: string
  email: string
  password: string
  role?: Role
  agency_id?: string | null
  employee_id?: string | null
}

/**
 * PATCH /api/users/{id}/access — from AccessUpdate. Added by PR #75.
 *
 * Sets role and agency together, validating the **resulting** pair rather than
 * the account's current state. That is the whole point of it: `/role` and
 * `/agency` each check against the half the other one needs changed first, so
 * an ADMIN could never be moved to any other role. This route has no such
 * ordering problem.
 *
 * The inverted rule still holds and is still enforced here - ADMIN with an
 * agency is a 422, and any other role without one is a 422. Both verified by
 * running the route, not by reading it.
 */
export interface UserAccessUpdate {
  role: Role
  /** Must be null for ADMIN, and a real agency for every other role. */
  agency_id: string | null
}

/**
 * PUT /api/users/{id} — from UserUpdate.
 *
 * Note what is absent: `role` and `agency_id`. Those move only through their
 * own PATCH routes, because each has a side effect this route does not perform
 * (a promotion to ADMIN clears the agency; an agency move also relocates the
 * linked employee).
 *
 * `exclude_unset` again: an omitted key is left alone, an explicit null clears
 * it. Sending `{employee_id: null}` unlinks the person; omitting the key keeps
 * the existing link.
 */
export interface UserUpdate {
  full_name?: string
  email?: string
  /** Sets a new password. Omit to leave it unchanged - never send "". */
  password?: string
  is_active?: boolean
  employee_id?: string | null
}

/**
 * Enforced by the `tickets.status` Enum column.
 *
 * `call` sets CALLED, `start-service` sets IN_SERVICE (manual, agent-pressed
 * - see AgentQueue.tsx), `complete` sets COMPLETED, `cancel` sets CANCELLED,
 * `skip` sets NO_SHOW (manual, agent-pressed, gated by the agency's
 * no_show_min_wait_seconds - never automatic or tracking-triggered).
 */
export const TICKET_STATUSES = [
  'WAITING',
  'CALLED',
  'IN_SERVICE',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/**
 * GET|POST /api/visitors, from VisitorResponse.
 *
 * A visitor is a member of the public who walked in - not an employee and not
 * an account. They are the only kind of person in this system with no login and
 * no card.
 */
export interface Visitor {
  id: string
  agency_id: string
  full_name: string
  phone: string | null
  identity_reference: string | null
  /** ISO 8601. */
  created_at: string
}

/**
 * POST /api/visitors — the request body, from VisitorCreate.
 *
 * `agency_id` is honoured only for an ADMIN. For every other role the backend
 * overwrites it with the caller's own agency, so sending one is pointless
 * rather than wrong. An ADMIN who omits it gets a 422.
 */
export interface VisitorCreate {
  full_name: string
  phone?: string | null
  identity_reference?: string | null
  agency_id?: string | null
}

/**
 * GET /api/tickets/queue and the four write routes, from TicketResponse.
 *
 * `visitor_name` and `agency_id` are flattened out of the visitor by the
 * backend, so a queue row needs no second request to be readable.
 *
 * `service_id`/`service_code`/`service_name` were added alongside the Services
 * contract (2026-08-27) and are nullable because a ticket predates them or its
 * service was deleted after the fact - `service.py`'s relationship has no
 * cascade rule that forbids that. `service_type` survives independently: the
 * backend still stores it as free text on the ticket (defaulting to the
 * service's name if the caller sends none), so it is not simply `service_name`
 * under another key.
 */
export interface Ticket {
  id: string
  visitor_id: string
  visitor_name: string
  agency_id: string
  service_id: string | null
  service_code: string | null
  service_name: string | null
  /** null until the ticket is called to a counter. */
  counter_id: string | null
  /** "YYYYMMDD-SERVICE_CODE-001", numbered per agency, service and day. */
  ticket_number: string
  service_type: string | null
  status: TicketStatus
  /** ISO 8601. */
  created_at: string
  called_at: string | null
  /** Set by POST /tickets/{id}/start-service - manual, agent-pressed. */
  in_service_at: string | null
  completed_at: string | null
  notes: string | null
  /** Set by a background task shortly after kiosk ticket creation, if the
   * agency has a kiosk zone configured and someone was standing in it.
   * Never set for tickets created any other way. */
  tracking_id: string | null
}

/**
 * GET /api/tickets/tracked, from TrackedTicketResponse - for the live map
 * (Tracking.tsx) to relabel a tracked person by ticket number instead of a
 * bare AI track id. Only non-terminal tickets that actually got linked.
 */
export interface TrackedTicket {
  ticket_id: string
  ticket_number: string
  tracking_id: string
}

/**
 * GET /api/employees/tracked, from TrackedEmployeeResponse - for the live map
 * (Tracking.tsx) to relabel a tracked person by employee name instead of a
 * bare AI track id. Employees have no terminal status the way tickets do, so
 * this is every currently-linked employee as-is, including the accepted
 * staleness trade-off (an id can go stale between badge scans).
 */
export interface TrackedEmployee {
  employee_id: string
  full_name: string
  tracking_id: string
}

/** GET /api/employees/roster - names to pick from when saying who a tracked person is. */
export interface RosterEntry {
  employee_id: string
  full_name: string
  agency_id: string
}

/**
 * POST /api/tickets — from TicketCreate. The visitor must already exist, and
 * `service_id` must reference a service in the visitor's own agency.
 * `service_type` is optional free text; the backend falls back to the
 * service's `name` when it is omitted.
 */
export interface TicketCreate {
  visitor_id: string
  service_id: string
  service_type?: string | null
}

/** POST /api/tickets/{id}/call — from TicketCallRequest. */
export interface TicketCall {
  counter_id: string
}

/**
 * GET|POST /api/devices and GET|PUT /api/devices/{id}, from DeviceResponse.
 * ADMIN, MANAGER and TECHNICIAN only - contracts/api.md §9, added 2026-08-27.
 */
export interface Device {
  id: string
  agency_id: string
  name: string
  /** Free text, upper-cased server-side (e.g. "DHT22"). No enum backs it. */
  device_type: string
  mqtt_client_id: string
  mqtt_topic: string
  status: DeviceStatus
  /** ISO 8601. null until the device has ever published. */
  last_seen_at: string | null
  /** Which AI-service zone this reader's badge scans correlate against for
   * the live-map employee tracking link. Set on the device form. */
  badge_zone_name: string | null
  /** How often this device should be heard from at least. Set = tracked in
   * the uptime history; null = event-driven (badge reader, kiosk), not tracked. */
  heartbeat_seconds: number | null
}

/**
 * POST /api/devices/agencies/{agency_id} — from DeviceCreate. `mqtt_topic`
 * defaults server-side to `agency/{agency_id}/device/{mqtt_client_id}/sensor`
 * when omitted, matching the MQTT consumer's subscription pattern.
 */
export interface DeviceCreate {
  name: string
  device_type: string
  mqtt_client_id: string
  mqtt_topic?: string | null
}

/** PUT /api/devices/{id} — from DeviceUpdate. All fields optional, exclude_unset. */
export interface DeviceUpdate {
  name?: string
  device_type?: string
  mqtt_client_id?: string
  mqtt_topic?: string | null
  status?: DeviceStatus
  badge_zone_name?: string | null
  heartbeat_seconds?: number | null
}

/**
 * POST /api/devices/agencies/{id} and POST /api/devices/{id}/rotate-key.
 *
 * `device_key` is the plaintext secret and is returned ONLY here - the backend
 * stores just its hash (`device_key_hash`) and every other response omits it.
 * There is no route to recover a lost key, only to rotate it and invalidate
 * the old one, so the UI has exactly one chance to show this value.
 */
export interface DeviceRegistration extends Device {
  device_key: string
}

/**
 * POST /api/controls/devices/{id}/command - from ManualControlRequest.
 * `target` is which door/lock/motor on a device that controls more than
 * one; optional, most devices won't need it. `action` must be one of the
 * device type's commands (GET /api/controls/commands), 422 otherwise.
 */
/** One manual command a device type accepts (contracts/device-commands.json). */
export interface DeviceCommand {
  action: string
  label: string
}

export interface ManualControlRequest {
  action: string
  target?: string | null
}

/**
 * POST /api/controls/devices/{id}/command's response - from
 * ManualControlResult. "unknown" means no ack arrived within the backend's
 * timeout - a real, distinct outcome, not a stand-in for failure.
 */
export interface ManualControlResult {
  status: 'confirmed' | 'failed' | 'unknown'
  detail: string | null
}

/**
 * GET /api/devices/{id}/thresholds and the two write routes, from
 * SensorThresholdResponse. `sensor_type` is free text lower-cased server-side
 * (e.g. "temperature"), not an enum - a device can report sensors this
 * dashboard has never named.
 */
export interface SensorThreshold {
  id: string
  device_id: string
  sensor_type: string
  unit: string | null
  warning_max: number | null
  critical_max: number | null
  is_active: boolean
}

/**
 * PUT /api/devices/{id}/thresholds/{sensor_type} — from SensorThresholdUpsert.
 * Creates the threshold if none exists for that sensor yet, otherwise replaces
 * it - there is no separate POST. At least one of `warning_max` /
 * `critical_max` is required, and `warning_max` must not exceed `critical_max`;
 * both are 422 refusals the server enforces, not this type.
 */
export interface SensorThresholdUpsert {
  unit?: string | null
  warning_max?: number | null
  critical_max?: number | null
  is_active?: boolean
}

/**
 * GET|POST /api/agencies/{agency_id}/cameras and PUT /api/cameras/{id}, from
 * CameraResponse in backend/app/schemas/camera.py. contracts/api.md §11,
 * added 2026-09-12. ADMIN, MANAGER and SECURITY; delete drops SECURITY.
 *
 * `name` is not a display label - it is the exact source identifier the AI
 * service knows the camera by, which is why it is unique across every branch
 * and not just within one (the AI source registry is site-wide). The names on
 * the Alerts screen come from that same registry, so a camera renamed here
 * stops matching its own detections until the backend re-syncs.
 *
 * `status` reuses the device enum, but only two of its values are ever written
 * for a camera: OFFLINE from creation until the backend receives its first
 * detection stream event, then ONLINE. Nothing sets ERROR or MAINTENANCE on a
 * camera today.
 */
export interface Camera {
  id: string
  agency_id: string
  name: string
  /**
   * An RTSP address, typically - which a browser cannot play, so it is shown
   * and edited here but never embedded. The schema allows null on the way out;
   * the create/update routes refuse it blank.
   */
  stream_url: string | null
  status: DeviceStatus
  /** Which AI detections run on it; null = all of them. */
  ai_features?: CameraAiFeature[] | null
}

/** The AI detections a camera can run (backend app/ai_alerts/camera_features.py). */
export const CAMERA_AI_FEATURES = ['weapon', 'fire', 'wanted', 'emotion'] as const
export type CameraAiFeature = (typeof CAMERA_AI_FEATURES)[number]

/** POST /api/agencies/{agency_id}/cameras — from CameraCreate. */
export interface CameraCreate {
  name: string
  stream_url: string
  /** null or omitted = every detection, [] = none. */
  ai_features?: CameraAiFeature[] | null
}

/** PUT /api/cameras/{id} — from CameraUpdate. All optional, exclude_unset. */
export interface CameraUpdate {
  name?: string
  stream_url?: string
  ai_features?: CameraAiFeature[] | null
}

/**
 * GET|PUT /api/ai-alerts/thresholds/weapon, from AIWeaponThresholdResponse.
 * contracts/api.md §12, added 2026-09-12. ADMIN, MANAGER and SECURITY.
 *
 * One global number, not per camera or per agency: the minimum confidence a
 * weapon detection needs before the backend turns it into an alert. Strictly
 * greater than 0 and at most 1, enforced server-side (422). It is separate
 * from the AI model's own `conf` cutoff - the model still reports everything
 * above its own bar, and this decides which of those anyone hears about.
 */
export interface WeaponThreshold {
  confidence: number
}

/**
 * The four computer-vision features that publish an alerts stream.
 *
 * From contracts/ai-service.md, which mounts `/{f}/alerts/stream` separately
 * per feature. Whether the backend proxy keeps them separate or merges them
 * into one is not settled yet - see the note on ALERT_STREAM_PATHS in
 * endpoints/streams.ts.
 */
export const ALERT_FEATURES = ['weapon', 'fire', 'emotion', 'wanted'] as const
export type AlertFeature = (typeof ALERT_FEATURES)[number]

/**
 * One detection inside an alerts frame.
 *
 * `class` is the detected label and its vocabulary depends on the feature -
 * "pistol" for weapon, a watchlist identifier for wanted. It is left as a
 * string because nothing in the contract enumerates them all.
 *
 * `confidence` means different things per feature and must not be rendered as
 * a percentage for `wanted`: there it is cosine similarity in [-1, 1], not a
 * probability. The contract says so explicitly.
 */
export interface AlertDetection {
  class: string
  confidence: number
  /** [x1, y1, x2, y2] in source-frame pixels. */
  bbox: [number, number, number, number]
  /** wanted only: face detector score, and the detected face size in pixels. */
  det_score?: number
  face_px?: number
  /**
   * wanted only: a base64 JPEG of the person, ~20KB, never written to disk.
   *
   * Attached once, to the highest-confidence detection - it is a property of
   * the frame, not of an individual match.
   */
  snapshot?: string
  /** Present on entries replayed from the hold window; the bbox may be stale. */
  held?: boolean
}

/**
 * WS alerts frames.
 *
 * Fires only when a camera's **set of detected classes** changes, not per
 * frame - confidence jitter alone sends nothing. So `detections: []` is the
 * all-clear, and a long silence means nothing changed rather than that the
 * feed died. A screen that expects periodic refreshes will conclude the
 * service is dead during a quiet afternoon.
 */
export type AlertFrame =
  | { type: 'snapshot'; cameras: Record<string, AlertDetection[]> }
  | { type: 'update'; camera: string; detections: AlertDetection[] }
  | AlertStateFrame

/** AlertSeverity / AlertStatus in backend/app/models/entities.py. */
export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'

/**
 * A stored business alert - GET /api/agencies/{agency_id}/alerts, from
 * AlertResponse. contracts/api.md §14, added in #112. ADMIN any agency,
 * MANAGER and SECURITY their own.
 *
 * Not the same thing as a live detection. The backend turns a detection into
 * one of these only when it clears the weapon threshold, and resolves it when
 * the camera clears; the live frames above report everything the model sees.
 * `camera_id` and `camera_name` are null once the camera has been deleted.
 * The model also has `title` and `message`, but the response leaves them out.
 */
export interface StoredAlert {
  id: string
  agency_id: string
  camera_id: string | null
  camera_name: string | null
  /** Sensor alerts: the device that raised it. */
  device_id?: string | null
  device_name?: string | null
  alert_type: string
  title?: string | null
  /** e.g. "Valeur depassee: 37 C" - kept current while the alert is open. */
  message?: string | null
  severity: AlertSeverity
  status: AlertStatus
  created_at: string
  resolved_at: string | null
  /** `intrusion` alerts: the tracked person it is about. */
  tracking_id?: string | null
}

/**
 * The weapon socket also pushes a stored alert's new state once the database
 * commit has gone through: the whole record, plus which change it was.
 * Filtered by agency and camera before delivery, like the detections.
 */
export interface AlertStateFrame extends StoredAlert {
  type: 'alert_state'
  event: 'created' | 'updated' | 'resolved'
}

/** One zone's occupancy inside an occupancy frame. */
export interface ZoneOccupancy {
  count: number
  /**
   * Positions that landed inside - floor centimetres for world zones, pixel
   * foot-points for pixel zones. A person can be in several overlapping zones
   * at once, and a boundary counts as inside, so counts may sum above the
   * number of people present.
   */
  points: Array<[number, number]>
}

/**
 * WS occupancy frames.
 *
 * Pushed only when a zone's count changes - there is no heartbeat, so an
 * unchanging count and a dead connection look identical from the payload
 * alone. The stream status badge is the thing that distinguishes them.
 */
export type OccupancyFrame =
  | { type: 'snapshot'; zones: Record<string, ZoneOccupancy> }
  | { type: 'update'; zone: string; count: number; points: Array<[number, number]> }

/**
 * A drawn detection zone — PROPOSED, not in contracts/api.md (2026-09-19).
 *
 * NOT THE SAME THING AS `Zone` ABOVE, and the collision is the API's, not
 * this file's. `Zone` is a room in a branch (`Accueil`, `Bureau · private`)
 * from backend/app/schemas/agency.py, created with the agency and carrying
 * `zone_type` / `is_private`. THIS is a polygon somebody drew over a camera
 * picture so the detector counts the people standing inside it
 * (contracts/ai-service.md §/zoning), and it lives in the AI service's own
 * store, not in our database. Nothing links the two today; whether they
 * should be linked is an open question for backend.
 * Named `CameraZone` here so no screen can confuse them by accident.
 *
 * `name` is the primary key — the AI service stores zones in a flat
 * name-keyed map, and re-posting a name OVERWRITES that zone, mode included.
 * There is no id.
 */
export type CameraZoneMode = 'pixel' | 'world'

export interface CameraZone {
  name: string
  /**
   * Inferred by the AI service from how many cameras the zone was saved
   * with, never sent by us: one camera is `pixel` (counted against that
   * camera's own raw detections, no calibration needed), two or more is
   * `world` (fused across every camera it was saved with, needs each one
   * calibrated AND aligned).
   */
  mode: CameraZoneMode
  /**
   * Which of our cameras it was drawn on, translated by the backend from the
   * camera name the AI service knows it by. Two different reasons this can
   * be null, not one:
   *   - PIXEL mode: the proxy could not match the AI service's camera name
   *     to a camera row - a zone drawn before the camera was renamed, or
   *     against a source this dashboard does not manage. A real orphan,
   *     worth surfacing as broken (see Zones.tsx's orphanZones).
   *   - WORLD mode: this is not an orphan, it is the AI service's own
   *     stored shape - a world zone genuinely has no single owning camera
   *     (ai/features/zoning/zones.py's zones_to_dict only writes a `camera`
   *     field for pixel zones at all). ALWAYS null for `mode: "world"`, by
   *     design, not by failure.
   */
  camera_id: string | null
  /** `pixel` mode: the polygon in that camera's own frame pixels. */
  polygon_px: Array<[number, number]> | null
  /** `world` mode: the polygon on the shared floor plane, in metres. */
  polygon_m: Array<[number, number]> | null
  /**
   * `world` mode only, and only when this zone was converted from a
   * just-drawn pixel polygon (which is the only way this dashboard creates
   * one) - which camera and pixel shape it came from, for traceability. A
   * world zone made some other way (the AI service's own tools, or the
   * reference console) may not carry this.
   */
  converted_from?: { camera: string; polygon_px: Array<[number, number]> } | null
  /** Who may stand in it - see PUT /api/zones/{name}/restriction. */
  restriction?: ZoneRestriction
}

/**
 * anyone: no watch. staff: only tracked people linked to an employee.
 * nobody: no one at all. Someone not allowed for more than a few seconds
 * opens an `intrusion` alert. World zones only.
 */
export type ZoneRestriction = 'anyone' | 'staff' | 'nobody'

/** GET /api/zones/intruders - who on the live map has an active intrusion alert. */
export interface Intruder {
  alert_id: string
  tracking_id: string
  title: string
}

/**
 * POST /api/zones — PROPOSED, the shape to ask backend for.
 *
 *   { "name": "lobby", "camera_id": "CAMERA_UUID",
 *     "polygon": [[120, 430], [980, 410], [1010, 700], [95, 720]] }
 *
 * `polygon` is at least 3 points in the drawn-on frame's own pixels, in the
 * order they were clicked; the closing edge is implied, so the first point is
 * not repeated at the end. The backend translates `camera_id` to the camera
 * name the AI service knows (the same mapping app/ai_alerts/consumer.py
 * already does) and fills in `sources` from the stream URL it holds — the
 * browser never handles RTSP credentials.
 *
 * `extra_camera_ids` is world mode: every OTHER camera this zone should be
 * fused across, by OUR uuid, same "the browser never sees a stream URL" rule
 * as `camera_id` — the backend resolves each one and builds the AI service's
 * `sources: {camera: url}` map itself. Omitted or empty means pixel mode
 * (one camera: `camera_id` alone, exactly what ai/features/zoning/api.py's
 * post_zone infers from a 1-entry `sources`). `camera_id` is always the
 * camera the polygon was actually drawn on — MUST be one of the fused set,
 * the AI service 422s otherwise (drawing on one camera and registering a
 * different one reads 0 forever, silently, so it refuses at save time
 * instead).
 */
export interface CameraZoneCreate {
  name: string
  camera_id: string
  polygon: Array<[number, number]>
  extra_camera_ids?: string[]
}

/**
 * What POST /api/zones answers with: the saved zone, plus whatever the AI
 * service warned about.
 *
 * `warnings` is passed through untouched and must be SHOWN. The AI service
 * uses it to say things like "'/people' is not currently running … this zone
 * will count 0 until it is" - a configuration mistake that is otherwise
 * indistinguishable from an empty room. Empty for a pixel zone on a healthy
 * service, which is the normal case here.
 */
export interface CameraZoneSaved extends CameraZone {
  warnings: string[]
}

/**
 * A workstation — PROPOSED, not in contracts/api.md (2026-09-19).
 *
 * A name bound to a zone somebody drew (`CameraZone` above), which the AI
 * service turns into "is anybody at this counter?".
 * contracts/ai-service.md §/employee_activity, which is built entirely on
 * /zoning's already-computed occupancy: no face recognition, no model of its
 * own, nothing about WHO is there. It answers whether the chair is filled.
 *
 * NOT ATTENDANCE, and the difference is the point. `AttendanceRecord` is a
 * badge at the door - who came to work today, from the RFID reader. This is
 * whether counter 3 is being manned at 14:40 while twelve people wait. An
 * employee can be present all day by one measure and away from their counter
 * by the other, and both readings are true.
 *
 * `name` is the primary key, as it is for a zone. No id.
 */
export const WORKSTATION_STATUSES = ['unknown', 'present', 'away'] as const
export type WorkstationStatus = (typeof WORKSTATION_STATUSES)[number]

export interface Workstation {
  name: string
  /** The `CameraZone.name` this watches. The zone must exist first. */
  zone: string
  /**
   * `present` fires on ANY sighting in the zone. `away` only after the zone
   * has been continuously empty for the service's absence window
   * (`employee_activity.absence_seconds`, 300s by default) - so a step away
   * to the printer does not read as "not working", and a screen must not
   * present `away` as if it were instant.
   *
   * `unknown` is not a third kind of absence: it means not classified yet.
   */
  status: WorkstationStatus
  /**
   * When the current status began - epoch SECONDS, float, not an ISO string
   * and not milliseconds. The AI service speaks Unix time here where the rest
   * of this dashboard speaks ISO 8601; converting at the edge (in the screen)
   * rather than pretending otherwise keeps the mismatch visible.
   */
  since: number
  /**
   * Whether the bound zone has ever actually been read.
   *
   * `false` means "not measured yet" and is DISTINCT from a measured empty
   * zone - a workstation bound to a zone whose camera has never produced a
   * frame sits at `unknown` with `zone_known: false` forever, and that is a
   * configuration problem, not a quiet counter.
   */
  zone_known: boolean
}

/**
 * POST /api/workstations — PROPOSED, the shape to ask backend for.
 *
 *   { "name": "guichet-3", "zone": "counters" }
 *
 * 422 when the zone does not exist yet, which is the AI service's own
 * refusal (§/employee_activity) and the reason the form picks from the zones
 * that exist rather than taking free text.
 */
export interface WorkstationCreate {
  name: string
  zone: string
}

/**
 * WS workstation frames.
 *
 * A snapshot of every workstation on connect, then one frame each time a
 * status ACTUALLY FLIPS - not per poll. So silence means nothing changed,
 * exactly as it does on the alerts and occupancy feeds, and the connection
 * badge is again the only thing that separates "steady" from "dead".
 */
export type WorkstationFrame =
  { type: 'snapshot'; workstations: Workstation[] } | ({ type: 'update' } & Workstation)

/**
 * Camera calibration — PROPOSED, not in contracts/api.md (2026-09-20).
 *
 * The one-time per-site geometry every multi-camera feature sits on:
 * world-mode zones, person tracking, anything that needs a real floor
 * position rather than one camera's pixels. contracts/ai-service.md
 * §/calibration, proxied by the backend.
 *
 * TWO FIELD NAMES BELOW COME FROM THE AI SOURCE, NOT THE CONTRACT, because
 * the contract's example for /calibration/align disagrees with what
 * ai/features/calibration/engine.py actually emits. Both are flagged for
 * the contract's owner; neither is invented here:
 *
 *   - The warning key is `reference_warning` (engine.py:581), not
 *     `results_warning` as the contract's example shows. Both are accepted
 *     below, because dropping a warning silently is the failure that costs
 *     something.
 *   - `fit` ("homography" | "affine" | "similarity") is written into the
 *     camera's stored diagnostics (engine.py:547), NOT into the per-camera
 *     entry of the align response the contract shows it in. So it is read
 *     from the diagnostics, where it exists.
 */

/**
 * What a calibrated camera knows about itself.
 *
 * Every field is one the AI service writes into `diag`
 * (ai/features/calibration/engine.py), surfaced through GET /calibration.
 * All optional: a camera calibrated before alignment carries only the
 * rectangle's own numbers, and gains the rest when it is aligned.
 */
export interface CalibrationDiagnostics {
  n_points?: number
  /**
   * DO NOT PRESENT AS ACCURACY. A 4-point fit is exact by construction, so
   * this is ~0 whether or not the clicked shape was really a right angle.
   * The contract says so in as many words. It says the maths ran, nothing
   * more, and a screen that shows it as a score teaches people to trust a
   * calibration that may be badly wrong.
   */
  px_err_mean?: number
  px_err_max?: number
  /** Free text; starts with "fallback" when the geometry was too degenerate. */
  aspect_source?: string
  inferred_aspect?: number
  aspect_stability_std?: number
  /** False means the rectangle's true shape was GUESSED as square. */
  aspect_confident?: boolean
  /** [w, h] the homography's pixel side is expressed in. */
  calib_res?: [number, number]
  aligned?: boolean
  aligned_to?: string
  aligned_with_n_points?: number
  /** Which transform the shared-point count supported. */
  fit?: string
  /** True when a >=4-point align replaced this camera's own rectangle. */
  aspect_superseded?: boolean
  note?: string
}

/**
 * One entry of GET /api/calibration.
 *
 * `Hinv` USED TO be deliberately absent here - the reasoning on record was
 * that the only thing a browser could do with it is draw the bird's-eye
 * overlay, and this screen didn't. That's no longer true (see the BEV mode
 * on the Calibration screen), so the decision flips: the proxy needs to
 * stop dropping it. The mock includes a (fake, affine-only) Hinv now regardless
 * of what the real proxy currently does, same as every other field here
 * that's ahead of a backend that hasn't caught up yet.
 */
export interface CameraCalibration {
  camera_id: string
  aligned: boolean
  diagnostics: CalibrationDiagnostics
  /** [3][3], camera pixel -> world metre. ai/features/calibration/engine.py's
   * own field name and shape. */
  Hinv: number[][]
}

/**
 * POST /api/calibration/rect — exactly 4 points, in order around a shape
 * that is a right angle in real life.
 *
 * `img_w` / `img_h` are REQUIRED by the service: the orthogonality solve
 * needs the image centre as an assumed principal point, and recording them
 * is what lets the calibration be rescaled if the frame size ever changes.
 * They must describe the frame the points were clicked on, which is why
 * this screen asks the proxy for a native-resolution frame rather than the
 * detector-scaled one the live view uses.
 */
export interface CalibrationRectRequest {
  camera_id: string
  points: Array<[number, number]>
  img_w: number
  img_h: number
}

/** The rect response is the diagnostics, plus whether it is aligned yet. */
export interface CalibrationRectResult extends CalibrationDiagnostics {
  aligned: boolean
}

/**
 * POST /api/calibration/align — the FULL accumulated list of shared-point
 * observations, not a delta. One entry per real point, naming the cameras
 * it was clicked in: `{ "CAMERA_UUID": [x, y], "OTHER_UUID": [x, y] }`.
 */
export type SharedPoint = Record<string, [number, number]>

export interface AlignCameraResult {
  aligned: boolean
  reference: boolean
  n_points: number | null
  /** Which camera it was chained through, null for the reference. */
  via: string | null
  /** Present when the point order fit better reversed - worth surfacing. */
  order_reversed?: boolean
  /** Present, and the whole story, when `aligned` is false. */
  error?: string
}

export interface AlignResult {
  /** The camera every other one was aligned to. */
  reference: string
  results: Record<string, AlignCameraResult>
  /** See the note at the top: the service emits `reference_warning`. */
  reference_warning?: string | null
  results_warning?: string | null
  /** Cameras aligned on fewer than 4 shared points keep their own aspect. */
  weak_fits?: string | null
  /** How far apart the cameras now place each recorded point. */
  residual_checks: Array<{
    pairs: Array<{ cam_a: string; cam_b: string; distance_cm: number }>
  }>
}

/**
 * POST /api/calibration/cross_check - read-only verification that an
 * alignment actually worked, as opposed to /calibration/align which
 * computes and SAVES one. Click the same real point in 2+ already-aligned
 * cameras; if the alignment is right, every camera's own world-coordinate
 * read of that point should roughly agree. `pairs` is the same shape
 * AlignResult.residual_checks uses for the same reason - it's the same
 * measurement, just against the current calibration instead of a proposed
 * one. See ai/features/calibration/api.py's /cross_check and
 * pairwise_distances().
 */
export interface CrossCheckResult {
  worlds: Record<string, [number, number]>
  pairs: Array<{ cam_a: string; cam_b: string; distance_cm: number }>
}

/**
 * An entry/exit location, marked once on a single already-calibrated
 * camera - not multi-camera agreement like alignment, just that one
 * camera's own Hinv turning a click into a floor coordinate. Used by
 * /people's tracker as a revival prior: an unmatched detection far from
 * every gate is assumed to be an existing tracked person whose position
 * drifted, not someone new walking in. See
 * ai/features/calibration/api.py's /gates.
 */
export interface Gate {
  camera: string
  points: Array<[number, number]>
}

/**
 * /people - live multi-camera person tracking, ai/features/person_tracking/api.py.
 *
 * BOOTSTRAP IS AUTOMATIC. There is deliberately no POST /people/start - it
 * kicks off once >=2 registered cameras are calibrated AND aligned, the same
 * "runs once its own minimal precondition exists" pattern every other
 * feature here uses. GET /people/status is the only observability an
 * explicit start endpoint would have given anyway.
 */
export type PeoplePhase = 'idle' | 'bootstrapping' | 'running' | 'error'

export interface PeopleStatus {
  phase: PeoplePhase
  person_scale: number | null
  /** The room's world bounding box, floor units - NOT a width/height pair.
   * Verified against the running service: `room` comes straight from
   * recover_heads_and_room's own xmin/xmax/ymin/ymax dict
   * (engine.py:173-201), not reshaped into a size anywhere. */
  room: { xmin: number; xmax: number; ymin: number; ymax: number } | null
  fps: number | null
  warnings: string[]
  error: string | null
  /** The camera set the CURRENT bootstrap ran against - compared every
   * cycle to the live registry to detect "sources changed, restart". */
  cams_bootstrapped: string[] | null
  /** A COUNT, not the gate list itself (len(gates), engine.py). */
  gates_loaded: number | null
  active_tracks: number | null
}

/**
 * GET /people/sources. Verified against the running service (2026-09-23):
 * the module's own docstring claims these three fields live on
 * GET /people/status instead - they don't, that docstring is stale. Built
 * against the real behavior, not the comment describing it.
 */
export interface PeopleSources {
  sources_known: string[]
  calibrated: string[]
  aligned: string[]
}

/** POST /people/sources - PeopleSources plus the warnings that call alone
 * computes (registering a source can immediately explain why nothing will
 * track yet). */
export interface PeopleSourcesUpdate extends PeopleSources {
  warnings: string[]
}

/** One confirmed track, world/floor coordinates (metres). */
export interface TrackDict {
  /** A number on the wire; streamMerge's applyPeopleFrame turns it into a string. */
  id: string
  x: number
  y: number
  hits: number
  misses: number
}

/**
 * WS /people/tracks/stream frames.
 *
 * `tracks` is the FULL confirmed-track snapshot every cycle once running,
 * not diffed the way the zoning/occupancy stream diffs its counts - a
 * moving person's position changes almost every cycle by construction, so a
 * diff would suppress almost nothing while adding a float-jitter bug
 * surface. `boxes` is per-camera PIXEL space (for a live-view overlay
 * elsewhere); the map on this screen plots `tracks`, which is already in
 * shared world space, not `boxes`.
 */
export type PeopleStreamFrame =
  | { type: 'snapshot'; state: PeoplePhase; tracks: TrackDict[] }
  /* The literal `{"type": "state", **_state}` spread (api.py's own
     _background_loop, verified against the running service) - every field
     PeopleStatus has except active_tracks, which only GET /status computes. */
  | ({ type: 'state' } & Omit<PeopleStatus, 'active_tracks'>)
  | {
      type: 'tracks'
      tracks: TrackDict[]
      boxes: Record<string, Array<[number, number, number, number]>>
    }

/**
 * /face — enrolled-staff face recognition, ai/features/face_recognition/api.py.
 *
 * ENROLLMENT ONLY. /face/scan and /face/capture are deliberately not
 * wrapped here at all: they're backend-triggered against a real hardware
 * event (a gate camera, a kiosk), the same way door access is RFID-triggered
 * and synchronous, not something an operator fires from a dashboard button.
 * Nothing on the backend orchestrates that yet either, so there is no
 * output to show and no trigger to build against - see FaceEntry's sibling
 * WatchlistEntry in the same file for the identically-shaped, deliberately
 * separate wanted-person gallery.
 */
export interface FaceEntry {
  name: string
  /** Every photo ever enrolled for this name, including earlier calls. */
  embeddings_count: number
}

/**
 * /watchlist — the wanted-person gallery, ai/features/wanted_detection/api.py.
 * Same enroll/list/delete shape as FaceEntry, a SEPARATE gallery on purpose
 * (the two route names and storage files never overlap, so "enrolled
 * employee" and "wanted person" can't be confused with each other even
 * though both processes run in the AI service).
 */
export interface WatchlistEntry {
  name: string
  embeddings_count: number
}

/** GET /watchlist/threshold. */
export interface WantedThreshold {
  threshold: number
  min_face_px: number
  startup_default: { threshold: number; min_face_px: number }
  floor: number
  watchlist_size: number
  embeddings_total: number
  /** A changed threshold isn't instant - this many seconds until it applies. */
  applies_within_seconds: number
}

/** GET /api/attendance/today, and the check-in / check-out responses. */
export interface AttendanceRecord {
  id: string
  employee_id: string
  employee_name: string
  agency_id: string
  /** ISO 8601. */
  check_in: string
  /** null while the employee is still in the building. */
  check_out: string | null
  method: AttendanceMethod
}

/**
 * POST /api/attendance/check-in and /check-out — the request body.
 *
 * The employee is identified by RFID, NOT by id. That is the contract's choice
 * and it is not an oversight: these routes exist to record what a badge reader
 * would have recorded, so they take the same key the reader emits. An employee
 * without a card cannot be checked in through this route at all.
 *
 * `agency_id` is accepted by the schema and has NO effect - the contract says
 * so explicitly for both routes. It is typed here because sending it is legal,
 * but nothing in this codebase should bother.
 */
export interface AttendanceMark {
  employee_rfid: string
  /** ISO 8601. Optional; the server uses the current time when omitted. */
  timestamp?: string | null
  agency_id?: string | null
}

/**
 * WS /ws/attendance
 *
 * The contract's example for this entry matches neither frame the backend
 * actually sends. Both real shapes come from attendance_to_dict(), which always
 * includes `id`; only the MQTT-triggered path adds `device_id`, taken from the
 * topic. The REST-triggered path (check-in / check-out endpoints) omits it.
 *
 * So `id` is optional here only because the contract says it is absent - in
 * practice it is always present. `device_id` is genuinely optional. The merge in
 * attendanceMerge.ts keys on neither, which is what makes it survive both.
 */
export interface AttendanceEvent {
  type: string
  event: string
  id?: string
  employee_id: string
  employee_name: string
  agency_id: string
  check_in: string
  check_out: string | null
  method: AttendanceMethod
  device_id?: string
}

/**
 * GET /api/announcements, from AnnouncementResponse - contracts/api.md,
 * added 2026-09-23. Everyone reads; posting/deleting is ADMIN and MANAGER.
 */
export interface Announcement {
  id: string
  /** null means site-wide - only an ADMIN may post one of those. */
  agency_id: string | null
  author_id: string | null
  title: string
  message: string
  created_at: string
}

/** POST /api/announcements — from AnnouncementCreate. */
export interface AnnouncementCreate {
  title: string
  message: string
  agency_id?: string | null
}

/**
 * GET /api/agencies/{id}/insights/satisfaction, from SatisfactionInsights -
 * contracts/api.md, added 2026-09-23. ADMIN, MANAGER and SECURITY.
 *
 * An aggregate emotion trend over the window, NOT a per-visitor or per-ticket
 * score - the AI stream carries class+confidence+bbox only, no track id.
 * `total_samples: 0` means no signal at all, not a neutral one - every pct
 * field is null in that case rather than a misleading 0.
 */
export interface SatisfactionInsights {
  window_hours: number
  total_samples: number
  counts_by_emotion: Record<string, number>
  positive_pct: number | null
  neutral_pct: number | null
  negative_pct: number | null
}

/** Part of InsightsOverview, from AlertsOverview. */
export interface AlertsOverview {
  open_by_severity: Record<string, number>
  open_total: number
}

/** Part of InsightsOverview, from TicketsOverview. */
export interface TicketsOverview {
  waiting: number
  in_service: number
  completed_today: number
  cancelled_today: number
}

/**
 * Part of InsightsOverview, from WaitTimeInsights. Four independent
 * averages over completed tickets in the window - each is null until at
 * least one completed ticket has both timestamps it needs. A ticket
 * completed without ever hitting "start service" has no in_service_at, so
 * it's excluded from avg_walk_over_seconds/avg_service_duration_seconds
 * specifically, not counted as zero.
 */
export interface WaitTimeInsights {
  window_hours: number
  sample_count: number
  avg_queue_wait_seconds: number | null
  avg_walk_over_seconds: number | null
  avg_service_duration_seconds: number | null
  avg_total_seconds: number | null
}

/**
 * Part of InsightsOverview, from VisitorRecognitionInsights - returning
 * visitors recognized by face alone, no name/ID ever required. `window_days`,
 * not `window_hours` - visit-return patterns operate on a days/weeks
 * timescale, unlike every other insight here. `avg_days_between_visits` is
 * an average, not a full distribution, same simplification every other
 * insight in this app already makes.
 */
export interface VisitorRecognitionInsights {
  window_days: number
  new_visitors: number
  returning_visitors: number
  returning_pct: number | null
  avg_days_between_visits: number | null
}

/**
 * Part of InsightsOverview, from ServiceSatisfactionInsights - same shape as
 * SatisfactionInsights, but scoped to exactly a ticket's
 * in_service_at-completed_at window on its counter's linked camera, instead
 * of every ambient sample in the agency. Additive sibling of `satisfaction`,
 * not a replacement - most agencies show zero coverage here until a manager
 * links a camera to a counter, which is honest, not a bug.
 * `tickets_with_coverage` is distinct from `total_samples` - a covered
 * ticket can still have zero actual samples if no face was visible.
 */
export interface ServiceSatisfactionInsights {
  window_hours: number
  tickets_with_coverage: number
  total_samples: number
  counts_by_emotion: Record<string, number>
  positive_pct: number | null
  neutral_pct: number | null
  negative_pct: number | null
}

/** GET /api/agencies/{id}/insights/overview, from InsightsOverview. */
export interface InsightsOverview {
  alerts: AlertsOverview
  tickets: TicketsOverview
  satisfaction: SatisfactionInsights
  wait_times: WaitTimeInsights
  visitor_recognition: VisitorRecognitionInsights
  service_satisfaction: ServiceSatisfactionInsights
}

/**
 * GET /api/agencies/{id}/climate/latest, from LatestReading - contracts/api.md,
 * added 2026-09-23. No role restriction, same as the outdoor-weather half of
 * this screen. One row per (device, sensor_type) at its own most recent
 * timestamp - a device can report several sensor types on different cadences,
 * so there is no single "latest reading" for a device as a whole.
 */
export interface LatestClimateReading {
  device_id: string
  device_name: string
  sensor_type: string
  value: number
  unit: string | null
  recorded_at: string
}

/** GET /api/push/public-key. `public_key` is null until the backend has VAPID keys. */
export interface PushPublicKey {
  public_key: string | null
  push_enabled: boolean
}

/** POST /api/push/subscriptions - the browser's PushSubscription.toJSON() shape. */
export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** One UTC day of GET /api/agencies/{id}/insights/trends. Zero-filled. */
export interface TrendDay {
  /** ISO date, YYYY-MM-DD. */
  date: string
  tickets_completed: number
  avg_service_seconds: number | null
  service_samples: number
  alerts_opened: number
  critical_alerts_opened: number
  satisfaction_samples: number
  positive_pct: number | null
  negative_pct: number | null
}

export interface CounterPerformance {
  counter_id: string
  number: number
  name: string | null
  tickets_completed: number
  avg_service_seconds: number | null
  service_samples: number
  busy_seconds: number
  /** Share of opening hours spent serving. Idle includes closed and unstaffed
   * time (no staffing history exists). null without usable opening hours. */
  utilization_pct: number | null
}

export interface ServicePerformance {
  service_id: string
  name: string
  tickets_completed: number
  avg_queue_wait_seconds: number | null
  avg_service_seconds: number | null
  service_samples: number
  /** Slowest among services with enough timed tickets to compare. */
  is_slowest: boolean
}

export interface TrendInsights {
  days: number
  opening_seconds_per_day: number | null
  daily: TrendDay[]
  counters: CounterPerformance[]
  services: ServicePerformance[]
}

export interface DeviceUptimeDay {
  date: string
  /** null = no samples that day, which is not the same as 0% online. */
  online_pct: number | null
}

export interface DeviceUptime {
  device_id: string
  name: string
  device_type: string
  heartbeat_seconds: number
  currently_online: boolean
  last_seen_at: string | null
  samples: number
  online_pct: number | null
  /** State changes between consecutive samples - a flickering device reads
   * the same as a steady one on percentage alone. */
  flaps: number
  tracking_since: string | null
  daily: DeviceUptimeDay[]
}

export interface UntrackedDevice {
  device_id: string
  name: string
  device_type: string
}

/** GET /api/agencies/{id}/insights/devices */
export interface DeviceUptimeInsights {
  days: number
  devices: DeviceUptime[]
  /** Event-driven devices (no heartbeat): quiet is normal, so not tracked. */
  untracked: UntrackedDevice[]
}

export interface AccessFailureEvent {
  occurred_at: string
  scanned_uid: string
  reason: string
  source: string
  /** Set when the card belongs to a known employee. */
  employee_name: string | null
}

export interface DoorAccessSummary {
  device_id: string
  name: string
  failures_in_window: number
  failures_24h: number
  distinct_cards_in_window: number
  by_reason: Record<string, number>
  last_failure_at: string | null
  flagged: boolean
  recent: AccessFailureEvent[]
}

/** GET /api/agencies/{id}/insights/access - failed badge attempts per door. */
export interface AccessFailureInsights {
  window_minutes: number
  /** null = the signal is switched off for this agency. */
  threshold: number | null
  doors: DoorAccessSummary[]
}

/**
 * One block of an agency's thermal-printer ticket layout
 * (GET|PUT /api/agencies/{id}/ticket-template). Rendered in array order.
 *
 * A saved IMAGE comes back from GET in its processed form - a 384-dot-wide,
 * 1-bit, dithered bitmap packed 48 bytes per row (`data`, `rows`) - not the
 * file that was uploaded. PUT accepts that processed form back unchanged, or a
 * fresh upload as a data URI in `content`.
 */
export type TicketTemplateBlock =
  | { type: 'text'; content: string }
  | { type: 'agency_name' }
  | { type: 'ticket_number' }
  | { type: 'service_name' }
  | { type: 'date' }
  | { type: 'qrcode'; content: string }
  | { type: 'image'; content: string }
  | { type: 'image'; data: string; rows: number }
  | { type: 'spacing'; lines: number }

export interface TicketTemplate {
  template: TicketTemplateBlock[]
}

export type SetupItemStatus = 'done' | 'todo' | 'unknown'

export interface SetupItem {
  key: string
  group: string
  label: string
  /** Why the step matters, shown for a step not yet done. */
  why: string
  /** unknown = the AI service could not be asked, which is not the same as todo. */
  status: SetupItemStatus
  detail: string
  /** The screen where the step is done; null = on the branch page itself. */
  link: string | null
}

/** GET /api/agencies/{id}/setup-status - a live, derived checklist. */
export interface SetupStatus {
  items: SetupItem[]
  done: number
  total: number
  complete: boolean
}

/** One branch of GET /api/insights/branches (ADMIN): the branch and its live overview. */
export interface BranchOverview {
  agency_id: string
  name: string
  is_active: boolean
  overview: InsightsOverview
}

/** Inclusive UTC days. */
export interface ReportPeriod {
  start: string
  end: string
  days: number
}

/** Tickets TAKEN in the period; how they ended and how long they took are read
 * off that same group, so the numbers add up. */
export interface TicketsReport {
  created: number
  completed: number
  cancelled: number
  no_show: number
  /** Still waiting or being served - only non-zero for a period reaching today. */
  unfinished: number
  completion_pct: number | null
  visitors_served: number
}

export interface AlertsReport {
  opened_total: number
  opened_by_severity: Record<string, number>
  opened_by_type: Record<string, number>
  resolved: number
  avg_resolve_minutes: number | null
}

export interface BusiestMoment {
  day: string | null
  day_tickets: number
  hour_utc: number | null
  hour_tickets: number
}

/** GET /api/agencies/{id}/report - and each row of the rollup. */
export interface AgencyReport {
  agency_id: string
  name: string
  period: ReportPeriod
  generated_at: string
  tickets: TicketsReport
  wait_times: WaitTimeInsights
  satisfaction: SatisfactionInsights
  service_satisfaction: ServiceSatisfactionInsights
  alerts: AlertsReport
  busiest: BusiestMoment
  /** Only on a single branch's report. */
  trends: TrendInsights | null
}

/** GET /api/reports/branches (ADMIN). */
export interface ReportRollup {
  period: ReportPeriod
  branches: AgencyReport[]
  /** Computed over every branch's raw data together, not by averaging the rows. */
  totals: AgencyReport
}

/**
 * contracts/api.md §25, GET/PATCH /api/ai/config. Detector tuning for the AI
 * service, ADMIN only. Values are numbers, booleans, strings or null.
 */
export type AiConfigValue = number | boolean | string | null
export type AiConfigSection = Record<string, AiConfigValue>
export type AiApplyMode = 'live' | 'next_start' | 'restart'

export interface AiConfig {
  config: Record<string, AiConfigSection>
  apply_modes: Record<string, Record<string, AiApplyMode>>
  startup_config: Record<string, AiConfigSection>
  pending_restart: Record<string, AiConfigSection>
}

export interface AiConfigPatch {
  changes: Record<string, AiConfigSection>
  persist: boolean
}

export interface AiConfigResult {
  applied: Record<string, Record<string, { value: AiConfigValue; mode: AiApplyMode }>>
  pending_restart: Record<string, AiConfigSection>
  previous: Record<string, AiConfigSection>
  persisted: boolean
}

/** GET /api/tickets/{id}/history - earlier visits of the same face. */
export interface VisitorHistory {
  /** false when no face was captured for this visit (not "first visit"). */
  recognised: boolean
  previous_visits: Array<{
    ticket_number: string
    service_name: string | null
    status: string
    created_at: string
    notes: string | null
  }>
}
