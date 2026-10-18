# Public API Contract (egress)

REST and WebSocket surface consumed by the frontend. Each endpoint owner is
responsible for keeping its contract entry synchronized with the backend.

Any change that removes an endpoint or changes/removes an existing field must
prefix the PR title with `BREAKING:` and be announced in `#api-contract`.

## Conventions

- Every endpoint requires a valid Bearer access token unless marked **Public**.
- A missing or invalid access token returns `401 Unauthorized`.
- UUID values are represented by placeholders such as `AGENCY_UUID`.
- Date-time values use ISO-8601 UTC format.
- Roles and enum values are returned in uppercase.
- Passwords and password hashes are never returned.
- Request bodies list only the fields accepted by the endpoint.
- Fields not listed in a partial update request are left unchanged.

## Roles

`ADMIN`, `MANAGER`, `AGENT`, `SECURITY`, `TECHNICIAN`

---

## 1. Authentication

### POST /api/auth/register

**Owner:** Backend
**Type:** REST
**Roles:** Public
**Request body:**

```json
{
  "full_name": "Hamza Benali",
  "email": "hamza@agency.com",
  "password": "SecurePass123",
  "agency_id": null
}
```

**Response body:**

```json
{
  "id": "USER_UUID",
  "full_name": "Hamza Benali",
  "email": "hamza@agency.com",
  "role": "AGENT",
  "agency_id": null,
  "is_active": true
}
```

**Success status:** `201 Created`
**Notes:** Public registration always creates an `AGENT` with no agency; an
administrator assigns the agency afterwards (`PATCH /api/users/{user_id}/agency`).
Sending an `agency_id` returns `403`. Errors: `409` if the email is already
registered, and `422` for invalid name, email or password.

### POST /api/auth/login

**Owner:** Backend
**Type:** REST
**Roles:** Public
**Request body:**

```json
{
  "email": "admin@test.com",
  "password": "SecurePass123"
}
```

**Response body:**

```json
{
  "access_token": "JWT_ACCESS_TOKEN",
  "refresh_token": "JWT_REFRESH_TOKEN",
  "token_type": "bearer",
  "user": {
    "id": "USER_UUID",
    "full_name": "Admin Test",
    "email": "admin@test.com",
    "role": "ADMIN",
    "agency_id": null,
    "is_active": true
  }
}
```

**Success status:** `200 OK`
**Notes:** Returns `401` for an unknown email or incorrect password (the two
are indistinguishable, including in response time) and `403` for a disabled
account. After 5 failed attempts for one email, or 30 from one client address,
within 10 minutes, further attempts return `429` with a `Retry-After` header
(seconds), even with the correct password. A successful login clears that
email's count.

### GET /api/auth/me

**Owner:** Backend
**Type:** REST
**Roles:** Any authenticated user
**Response body:**

```json
{
  "id": "USER_UUID",
  "full_name": "Hamza Benali",
  "email": "hamza@agency.com",
  "role": "MANAGER",
  "agency_id": "AGENCY_UUID",
  "is_active": true
}
```

**Success status:** `200 OK`

### POST /api/auth/refresh

**Owner:** Backend
**Type:** REST
**Roles:** Public with a valid refresh token
**Request body:**

```json
{
  "refresh_token": "JWT_REFRESH_TOKEN"
}
```

**Response body:** Same shape as `POST /api/auth/login`.
**Success status:** `200 OK`
**Notes:** Returns `401` if the refresh token is missing, invalid, expired or
belongs to a disabled/non-existent user.

---

## 2. Agencies

### GET /api/agencies

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "id": "AGENCY_UUID",
    "name": "Agence Casablanca",
    "address": "Casablanca",
    "phone": "0522000000",
    "opening_time": "08:30:00",
    "closing_time": "16:30:00",
    "is_active": true,
    "no_show_min_wait_seconds": 60,
    "kiosk_zone_name": null,
    "weapon_lockdown_enabled": false,
    "access_failure_threshold": 5,
    "access_failure_window_minutes": 10,
    "queue_depth_warning": 5,
    "queue_depth_critical": 10,
    "oldest_wait_warning_seconds": 600,
    "oldest_wait_critical_seconds": 1200,
    "zones": [
      {
        "id": "ZONE_UUID",
        "name": "Accueil",
        "zone_type": "PUBLIC",
        "is_private": false
      }
    ],
    "counters": [
      {
        "id": "COUNTER_UUID",
        "number": 1,
        "name": "Guichet 1",
        "point_type": "COUNTER",
        "is_open": true,
        "service_id": null,
        "emotion_camera_id": null,
        "workstation_name": null
      }
    ],
    "employees_count": 4,
    "devices_count": 2,
    "cameras_count": 3
  }
]
```

**Success status:** `200 OK`
**Notes:** `ADMIN` sees all agencies. `MANAGER` sees only their own agency.
`no_show_min_wait_seconds` defaults to `60` and is set per agency via
`PUT /api/agencies/{agency_id}` — how long an agent must wait after calling a
ticket before `POST /api/tickets/{ticket_id}/skip` is allowed.

The settings fields are described under `PUT /api/agencies/{agency_id}`.

### POST /api/agencies

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "name": "Agence Casablanca",
  "address": "Casablanca",
  "phone": "0522000000",
  "opening_time": "08:30:00",
  "closing_time": "16:30:00",
  "zones": [
    {
      "name": "Accueil",
      "zone_type": "PUBLIC",
      "is_private": false
    }
  ],
  "counters": [
    {
      "number": 1,
      "name": "Guichet 1",
      "point_type": "COUNTER",
      "is_open": true
    }
  ]
}
```

**Response body:** Agency object with generated IDs for the agency, zones and
counters.
**Success status:** `201 Created`
**Notes:** `name` is required. Counter numbers must be unique within the
agency.

### GET /api/agencies/{agency_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** One agency object.
**Success status:** `200 OK`
**Notes:** `MANAGER` can access only their own agency. Returns `404` if the
agency does not exist.

### GET /api/agencies/{agency_id}/ticket-template

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER` for their own agency
**Response body:**

```json
{
  "template": [
    { "type": "text", "content": "Bienvenue chez nous" },
    { "type": "agency_name" },
    { "type": "ticket_number" },
    { "type": "service_name" },
    { "type": "date" }
  ]
}
```

**Success status:** `200 OK`
**Notes:** Returns the saved `Agency.ticket_template`, or the following
built-in default when it is unset:

```json
[
  { "type": "text", "content": "Bienvenue chez nous" },
  { "type": "agency_name" },
  { "type": "ticket_number" },
  { "type": "service_name" },
  { "type": "date" }
]
```

Supported blocks are `text`, `agency_name`, `ticket_number`, `service_name`,
`date`, `qrcode`, `image` and `spacing`. Blocks are rendered in array order.
`agency_name`, `ticket_number`, `service_name` and `date` take no content and
are resolved at print time. `image` input is converted server-side to a
384-dot-wide, 1-bit Floyd-Steinberg dithered bitmap and returned as base64
packed rows (`data`, 48 bytes per row, most-significant bit first, bit `1` is
black) with `rows`. The array is a layout description, not raw ESC/POS; the
kiosk converts each block to ESC/POS printer commands.

### PUT /api/agencies/{agency_id}/ticket-template

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER` for their own agency
**Request body:**

```json
{
  "template": [
    { "type": "text", "content": "Bienvenue chez nous" },
    { "type": "agency_name" },
    { "type": "ticket_number" },
    { "type": "service_name" },
    { "type": "date" },
    { "type": "qrcode", "content": "https://example.com" },
    { "type": "image", "content": "data:image/png;base64,RAW_UPLOADED_IMAGE" },
    { "type": "spacing", "lines": 2 }
  ]
}
```

**Response body:** Updated template in the same processed shape as the GET
endpoint.
**Success status:** `200 OK`
**Notes:** Replaces the complete template. Allowed block types are `text`,
`agency_name`, `ticket_number`, `service_name`, `date`, `qrcode`, `image` and
`spacing`. Image input uses a base64 image data URI in `content`; the backend
resizes it to 384 pixels wide and applies 1-bit Floyd-Steinberg dithering.
`422` is returned for an empty template, an unknown type or a missing required
field. The kiosk refreshes its copy at boot and every 60 seconds. `404` is
returned when the agency does not exist.

### PUT /api/agencies/{agency_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER` for their own agency
**Request body:**

```json
{
  "name": "Agence Casablanca Updated",
  "address": "New address",
  "phone": "0522000000",
  "opening_time": "08:30:00",
  "closing_time": "17:00:00",
  "is_active": true,
  "no_show_min_wait_seconds": 90,
  "kiosk_zone_name": "Kiosk",
  "weapon_lockdown_enabled": true,
  "access_failure_threshold": 5,
  "access_failure_window_minutes": 10,
  "queue_depth_warning": 5,
  "queue_depth_critical": 10,
  "oldest_wait_warning_seconds": 600,
  "oldest_wait_critical_seconds": 1200
}
```

**Response body:** Updated agency object.
**Success status:** `200 OK`
**Notes:** All fields are optional; only the fields included in the request
are updated.

Per-agency settings, all optional:

- `kiosk_zone_name`: name of an AI zone (Zones screen) used to link a kiosk
  ticket to the person standing in it. `null` disables the link.
- `kiosk_face_camera_id`: the camera that sees faces at the kiosk. Used for the
  returning-visitor face capture and for linking a watchlist match to the
  ticket; when `null`, the kiosk zone's camera is used. Must be a camera of
  this agency (`404` unknown, `422` another agency's).
- `weapon_lockdown_enabled`: default `false`. When `true`, a weapon detection
  that stays present for 4 seconds locks every door device in the agency.
  Never locks while a fire or gas alert is open, and never unlocks
  automatically. Each change is written to the audit log.
- `access_failure_threshold` (at least 1) and `access_failure_window_minutes`
  (1 to 1440): a door is flagged in `insights/access` when it has that many
  failed badge attempts inside the window. A `null` threshold turns the
  signal off. Defaults `5` and `10`.
- `queue_depth_warning`, `queue_depth_critical` (waiting tickets) and
  `oldest_wait_warning_seconds`, `oldest_wait_critical_seconds` (at least 1):
  dashboard colour thresholds for the queue; they never raise an alert. A
  `null` value turns that threshold off. Defaults `5`, `10`, `600`, `1200`.

### DELETE /api/agencies/{agency_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:** Empty
**Success status:** `204 No Content`
**Notes:** Returns `404` if the agency does not exist.

---

## 3. Services and service points

### GET /api/agencies/{agency_id}/services

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:**

```json
[
  {
    "id": "SERVICE_UUID",
    "agency_id": "AGENCY_UUID",
    "code": "VIR",
    "name": "Virement et consultation",
    "description": "Virements et consultation de compte",
    "point_type": "COUNTER",
    "min_points": 2,
    "is_active": true
  }
]
```

**Success status:** `200 OK`

### POST /api/agencies/{agency_id}/services

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "code": "VIR",
  "name": "Virement et consultation",
  "description": "Virements et consultation de compte",
  "point_type": "COUNTER",
  "min_points": 2,
  "is_active": true
}
```

**Response body:** Service object with generated `id`.
**Success status:** `201 Created`
**Notes:** `code` is unique per agency. `point_type` is `COUNTER` or `OFFICE`.

### GET /api/services/{service_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:** Service object.
**Success status:** `200 OK`

### PUT /api/services/{service_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "code": "VIR",
  "name": "Virement et consultation de compte",
  "description": "Transfers and account queries",
  "point_type": "COUNTER",
  "min_points": 2,
  "is_active": true
}
```

**Response body:** Updated service object.
**Success status:** `200 OK`
**Notes:** All fields are optional. `code` is 2 to 50 characters from
`A-Z a-z 0-9 _ -`, `description` at most 500, `point_type` is `COUNTER` or
`OFFICE`, `min_points` is 1 to 100. A service point already assigned to the service prevents changing
its `point_type`.

### DELETE /api/services/{service_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** Empty
**Success status:** `204 No Content`
**Notes:** Deletion is refused while points or tickets still reference the
service.

### GET /api/services/{service_id}/points

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:**

```json
[
  {
    "id": "COUNTER_UUID",
    "agency_id": "AGENCY_UUID",
    "service_id": "SERVICE_UUID",
    "number": 1,
    "name": "Guichet principal",
    "point_type": "COUNTER",
    "is_open": true
  }
]
```

**Success status:** `200 OK`

### PATCH /api/counters/{counter_id}/service

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "service_id": "SERVICE_UUID"
}
```

**Response body:** Updated service point object.
**Success status:** `200 OK`
**Notes:** The service and point must belong to the same agency. Send
`{"service_id": null}` to remove the assignment.

---

## 4. Employees

### GET /api/employees

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "id": "EMPLOYEE_UUID",
    "agency_id": "AGENCY_UUID",
    "first_name": "Hamza",
    "last_name": "Benali",
    "email": "hamza@agency.com",
    "phone": "0612345678",
    "position": "Agent d'accueil",
    "rfid_uid": "RFID-001",
    "role": "AGENT",
    "authorized_zone_ids": ["ZONE_UUID"],
    "status": "ACTIVE",
    "hire_date": "2026-08-01",
    "is_active": true
  }
]
```

**Success status:** `200 OK`
**Notes:** `ADMIN` sees all employees. `MANAGER` sees only their own agency.

### POST /api/employees

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "first_name": "Hamza",
  "last_name": "Benali",
  "email": "hamza@agency.com",
  "phone": "0612345678",
  "position": "Agent d'accueil",
  "agency_id": "AGENCY_UUID",
  "rfid_uid": "RFID-001",
  "role": "AGENT",
  "authorized_zone_ids": ["ZONE_UUID"],
  "status": "ACTIVE",
  "hire_date": "2026-08-01"
}
```

**Response body:** Employee object.
**Success status:** `201 Created`
**Notes:** `ADMIN` must provide `agency_id`. `MANAGER` employees are always
created in the manager's agency. `email` and `rfid_uid` must be unique. `role`
is informational/API-related; physical access is defined independently by
`authorized_zone_ids`, which contains zone IDs assigned to this employee.
The list can be changed during employee creation or update. `role` accepts
`ADMIN`, `MANAGER`, `AGENT`, `SECURITY` or `TECHNICIAN`.

### GET /api/employees/{employee_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** Employee object.
**Success status:** `200 OK`

### PUT /api/employees/{employee_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "first_name": "Hamza",
  "last_name": "Benali",
  "email": "hamza.updated@agency.com",
  "phone": "0600000000",
  "position": "Supervisor",
  "agency_id": "AGENCY_UUID",
  "rfid_uid": "04A1B2C3",
  "role": "AGENT",
  "authorized_zone_ids": ["ZONE_UUID"],
  "status": "ACTIVE",
  "hire_date": "2026-01-15"
}
```

**Response body:** Updated employee object.
**Success status:** `200 OK`
**Notes:** All fields are optional.
A `MANAGER` cannot move an employee to another agency.

### DELETE /api/employees/{employee_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** Empty
**Success status:** `204 No Content`

---

## 5. Users, roles and permissions

All endpoints in this section require the `ADMIN` role.

### GET /api/users

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:**

```json
[
  {
    "id": "USER_UUID",
    "full_name": "Sara Security",
    "email": "sara@agency.com",
    "role": "SECURITY",
    "agency_id": "AGENCY_UUID",
    "employee_id": "EMPLOYEE_UUID",
    "is_active": true,
    "employee": {
      "id": "EMPLOYEE_UUID",
      "first_name": "Sara",
      "last_name": "Security",
      "agency_id": "AGENCY_UUID",
      "rfid_uid": "RFID-SEC-001",
      "role": "SECURITY",
      "authorized_zone_ids": ["ZONE_UUID"]
    }
  }
]
```

**Success status:** `200 OK`

### POST /api/users

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "full_name": "Sara Security",
  "email": "sara@agency.com",
  "password": "SecurePass123",
  "role": "SECURITY",
  "agency_id": "AGENCY_UUID",
  "employee_id": "EMPLOYEE_UUID"
}
```

**Response body:** User object.
**Success status:** `201 Created`
**Notes:** `ADMIN` must have `agency_id: null`. All other roles require an
existing agency. `employee_id` is optional and links one employee to one user.

### GET /api/users/{user_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:** User object.
**Success status:** `200 OK`

### PUT /api/users/{user_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "full_name": "Sara Security Updated",
  "email": "sara.updated@agency.com",
  "password": "NewSecurePass123",
  "is_active": true,
  "employee_id": "EMPLOYEE_UUID"
}
```

**Response body:** Updated user object.
**Success status:** `200 OK`
**Notes:** This route does not change `role` or `agency_id`.

### PATCH /api/users/{user_id}/role

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "role": "TECHNICIAN"
}
```

**Response body:** Updated user object.
**Success status:** `200 OK`
**Notes:** Converting to `ADMIN` clears `agency_id`. To change role and agency
at the same time, use `/access`.

### PATCH /api/users/{user_id}/agency

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "agency_id": "AGENCY_UUID"
}
```

**Response body:** Updated user object.
**Success status:** `200 OK`
**Notes:** The agency must be compatible with the user's current role.

### PATCH /api/users/{user_id}/access

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "role": "SECURITY",
  "agency_id": "AGENCY_UUID"
}
```

**Response body:**

```json
{
  "id": "USER_UUID",
  "full_name": "Sara Security",
  "email": "sara@agency.com",
  "role": "SECURITY",
  "agency_id": "AGENCY_UUID",
  "employee_id": "EMPLOYEE_UUID",
  "is_active": true,
  "employee": null
}
```

**Success status:** `200 OK`
**Notes:** Updates role and agency atomically using the resulting state. An
`ADMIN` must have `agency_id: null`; every other role requires an existing
agency. A linked employee follows the new agency when one is provided.

### DELETE /api/users/{user_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:** Empty
**Success status:** `204 No Content`
**Notes:** An `ADMIN` cannot delete their own account. Returns `400` for that
case and `404` if the user does not exist.

### GET /api/agents/me/assignment

**Owner:** Backend
**Type:** REST
**Roles:** `AGENT`
**Response body when assigned:**

```json
{
  "counter_id": "COUNTER_UUID",
  "counter_name": "Guichet virement",
  "service_id": "SERVICE_UUID",
  "service_name": "Virement et consultation",
  "no_show_min_wait_seconds": 60
}
```

**Response body when not assigned:**

```json
null
```

**Success status:** `200 OK`
**Notes:** `no_show_min_wait_seconds` is the assigned agent's own agency's
value (see §2 Agencies) — this is how `AGENT`-role accounts learn it, since
`GET /api/agencies/{agency_id}` is `ADMIN`/`MANAGER` only.
**Notes:** Returns the current guichet or bureau assigned to the authenticated
AGENT. The assigned point must belong to the agent's agency and have an active
service.

### GET /api/agencies/{agency_id}/agents

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER` for their own agency
**Response body:**

```json
[
  {
    "user_id": "USER_UUID",
    "full_name": "Agent Accueil",
    "assignment": {
      "counter_id": "COUNTER_UUID",
      "counter_name": "Guichet virement",
      "service_id": "SERVICE_UUID",
      "service_name": "Virement et consultation",
      "no_show_min_wait_seconds": 60
    },
    "attendance": {
      "state": "checked_in",
      "at": "2026-08-25T08:31:00Z"
    }
  },
  {
    "user_id": "ANOTHER_USER_UUID",
    "full_name": "Agent Sans Affectation",
    "assignment": null,
    "attendance": null
  }
]
```

**Success status:** `200 OK`
**Notes:** Returns every active AGENT and MANAGER account in the agency (a
manager can cover a counter too); each row also carries `role`. `MANAGER` can only read
agents from their own agency; `ADMIN` can read any agency. The route is
`attendance` is today's badge state for an agent with a linked employee, or
`null` without one: `state` is `checked_in`, `checked_out`, `not_checked_in`
or `unavailable` (the badge feed itself is down, so a missing badge-in proves
nothing); `at` is the time of the last badge event, or `null`. The route is
separate from `GET /api/users`, which remains restricted to `ADMIN`.

### PATCH /api/agents/{user_id}/assignment

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER` for agents in their own agency
**Request body to assign a point:**

```json
{
  "counter_id": "COUNTER_UUID"
}
```

**Request body to clear the assignment:**

```json
{
  "counter_id": null
}
```

**Response body:** Agent assignment object, or `null` when the assignment is
cleared.
**Success status:** `200 OK`
**Notes:** The target user must have role `AGENT` or `MANAGER` (`422`
otherwise). The counter must belong to
the same agency and must already be linked to an active service. A counter
without a service returns `409`; an agency mismatch returns `422`; an unknown
user or counter returns `404`. Changing an agent's role or agency clears its
counter assignment.

---

## 6. RFID attendance

The public REST endpoints in this section are explicit/manual operations: the
authenticated client chooses `check-in` or `check-out`. RFID hardware does not
choose or send an event. It sends only the card identifier through the internal
ingestion contract in `contracts/ingestion.md`, and the backend decides the
operation from the employee's current attendance state:

- no open attendance record -> create a `check_in`;
- an open attendance record -> close it with a `check_out`.

The backend decision is returned in the internal response and is also exposed
in the attendance WebSocket event. This prevents the hardware and backend from
disagreeing about the employee's status.

### POST /api/attendance/check-in

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "employee_rfid": "RFID-001",
  "timestamp": "2026-08-25T08:30:00Z",
  "agency_id": null
}
```

**Response body:**

```json
{
  "id": "ATTENDANCE_UUID",
  "employee_id": "EMPLOYEE_UUID",
  "employee_name": "Hamza Benali",
  "agency_id": "AGENCY_UUID",
  "check_in": "2026-08-25T08:30:00Z",
  "check_out": null,
  "method": "RFID"
}
```

**Success status:** `200 OK`
**Notes:** This is the explicit check-in route for authenticated applications.
The employee is identified by `employee_rfid`. `timestamp` and `agency_id` are
optional. A `MANAGER` or `SECURITY` user is restricted to their own agency.
RFID devices must use `POST /internal/attendance/check-rfid` instead and must
not send an `event` field.

### POST /api/attendance/check-out

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:** Same shape as check-in.
**Response body:** Attendance object with a non-null `check_out`.
**Success status:** `200 OK`
**Notes:** This is the explicit check-out route for authenticated applications.
It returns `409` if the employee has no open attendance record. RFID devices do
not call this route directly; the backend automatically selects check-in or
check-out through the internal RFID ingestion endpoint.

### GET /api/attendance/today

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:** Array of attendance objects.
**Success status:** `200 OK`
**Notes:** `ADMIN` sees all agencies. `MANAGER` and `SECURITY` see their own
agency only.

### GET /api/attendance/employee/{employee_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:** Array of attendance objects ordered from newest to oldest.
**Success status:** `200 OK`

### WS /ws/attendance?token=JWT_ACCESS_TOKEN

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Message body:**

```json
{
  "id": "ATTENDANCE_UUID",
  "type": "attendance_updated",
  "event": "check_in",
  "employee_id": "EMPLOYEE_UUID",
  "employee_name": "Hamza Benali",
  "agency_id": "AGENCY_UUID",
  "check_in": "2026-08-25T08:30:00Z",
  "check_out": null,
  "method": "RFID"
}
```

**Notes:** The `id` field is always present. MQTT-triggered messages also
include `device_id`; REST-triggered messages do not. For an RFID-triggered
message, `event` is the backend decision (`check_in` or `check_out`); the RFID
reader did not provide that field. The connection is closed with code `1008`
for a missing, invalid, expired or refresh token, a deactivated account, any
other role, or a `MANAGER` or `SECURITY` user with no agency. The user is
checked against the database, so a deactivated account stops receiving events
at once. A `MANAGER` or `SECURITY` user receives only their own agency's
events; an `ADMIN` receives every agency's.

---

## 7. Visitors

### POST /api/visitors

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`, `SECURITY`
**Request body:**

```json
{
  "full_name": "Client Test",
  "phone": "0612345678",
  "identity_reference": "CIN123456",
  "agency_id": "AGENCY_UUID"
}
```

**Response body:** Visitor object.
**Success status:** `201 Created`
**Notes:** `ADMIN` must provide an agency. For other roles, the visitor is
created in the caller's agency.

### GET /api/visitors

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`, `SECURITY`
**Response body:** Array of visitor objects.
**Success status:** `200 OK`
**Notes:** Non-`ADMIN` users see only their own agency.

### GET /api/visitors/{visitor_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`, `SECURITY`
**Response body:** Visitor object.
**Success status:** `200 OK`

---

## 8. Tickets

All ticket response objects include the following completion-note field:

```json
{
  "notes": "Dossier vérifié, visite terminée."
}
```

`notes` is `null` until the ticket is finalized. It is populated only by
`POST /api/tickets/{ticket_id}/complete` and is returned unchanged by the
other ticket endpoints. It is limited to 2,000 characters; leading and
trailing whitespace is removed and a blank value is stored as `null`.

### POST /api/tickets

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Request body:**

```json
{
  "visitor_id": "VISITOR_UUID",
  "service_id": "SERVICE_UUID",
  "service_type": "Virement et consultation"
}
```

**Response body:**

```json
{
  "id": "TICKET_UUID",
  "visitor_id": "VISITOR_UUID",
  "visitor_name": "Client Test",
  "agency_id": "AGENCY_UUID",
  "service_id": "SERVICE_UUID",
  "service_code": "VIR",
  "service_name": "Virement et consultation",
  "counter_id": null,
  "ticket_number": "20260825-VIR-001",
  "service_type": "Virement et consultation",
  "status": "WAITING",
  "created_at": "2026-08-25T14:32:00Z",
  "called_at": null,
  "in_service_at": null,
  "completed_at": null,
  "notes": null,
  "tracking_id": null
}
```

**Success status:** `201 Created`
**Notes:** `service_id` is required and must belong to the visitor's agency.
Ticket numbers use `YYYYMMDD-SERVICE_CODE-001` and restart for each agency,
service and day. Every ticket object carries `tracking_id`: the live-map track
linked to the ticket, `null` at creation. A kiosk ticket is linked shortly
after creation when the agency has a `kiosk_zone_name` and someone was
standing in that zone.

### GET /api/tickets/queue?service_id=SERVICE_UUID

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:** Array of ticket objects in `WAITING` status, oldest first.
**Success status:** `200 OK`
**Notes:** `service_id` is optional. Non-`ADMIN` users see only their own
agency queue.

### POST /api/tickets/{ticket_id}/call

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Request body:**

```json
{
  "counter_id": "COUNTER_UUID"
}
```

**Response body:** Ticket object with `status: "CALLED"`, `counter_id` and
`called_at` populated.
**Success status:** `200 OK`
**Notes:** The ticket must be `WAITING`. The counter must be open, belong to
the same agency and be assigned to the ticket's service and point type.
Always send the counter UUID, never the visible counter number.

### GET /api/tickets/{ticket_id}/history

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:**

```json
{
  "recognised": true,
  "previous_visits": [
    {
      "ticket_number": "20261019-DEV-VIR-001",
      "service_name": "Virement et consultation",
      "status": "COMPLETED",
      "created_at": "2026-10-19T08:30:13Z",
      "notes": "string"
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** Earlier visits of the same person, matched by the face captured at
the kiosk (same matching and threshold as the returning-visitor count in
Insights), newest first, at most 5. `recognised` is `false` when no face was
captured for this visit (which does not mean it is a first visit). Non-`ADMIN`
users only for their own agency (`403`); `404` if the ticket does not exist.

### POST /api/tickets/{ticket_id}/complete

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Request body (optional):**

```json
{
  "notes": "Dossier vérifié, visite terminée."
}
```

`notes` may be `null` and is limited to 2,000 characters. Leading and trailing
whitespace is removed; a blank value is stored as `null`.

**Response body:** Ticket object with `status: "COMPLETED"`, `completed_at`
and the persisted `notes`.
**Success status:** `200 OK`
**Notes:** Only `CALLED` and `IN_SERVICE` tickets can be completed. A ticket
completed straight from `CALLED` gets `in_service_at` set to its `called_at`,
so the visit still has a service time and a satisfaction window. The body
may be omitted for clients that do not record a note. Sending `{ "notes": null
}` explicitly clears the note before the ticket is saved as completed.

### POST /api/tickets/{ticket_id}/cancel

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:** Ticket object with `status: "CANCELLED"`.
**Success status:** `200 OK`
**Notes:** `COMPLETED` and already `CANCELLED` tickets cannot be cancelled.

### POST /api/tickets/{ticket_id}/start-service

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Request body:** None
**Response body:** Ticket object with `status: "IN_SERVICE"` and `in_service_at`
set to the current time.
**Success status:** `200 OK`
**Notes:** Only valid from `CALLED`, else `409`. Always a manual action — marks
the moment the visitor actually arrived at the counter, never inferred
automatically. Splits the previously blended time-to-completion into
queue-wait (`called_at` → `in_service_at`) and actual service duration
(`in_service_at` → `completed_at`). Optional: `POST .../complete` still
accepts a ticket straight from `CALLED` without this ever being called.

### POST /api/tickets/{ticket_id}/skip

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Request body:** None
**Response body:** Ticket object with `status: "NO_SHOW"`.
**Success status:** `200 OK`
**Notes:** Tickets also become `NO_SHOW` without this route: once a branch's `closing_time` has passed (machine local time), every ticket it created before that moment and left `WAITING` or `CALLED` is marked `NO_SHOW` with the note "Fermeture de l'agence: ticket non servi", checked about once a minute. Only valid from `CALLED`, and only once
`no_show_min_wait_seconds` (see §2 Agencies) has elapsed since `called_at` —
otherwise `409` with the remaining seconds in the message. Always a manual,
agent-pressed action; nothing on the backend ever sets this status on its
own.

### Ticket status values

`WAITING`, `CALLED`, `IN_SERVICE`, `COMPLETED`, `CANCELLED`, `NO_SHOW`

---

## 9. IoT devices

### GET /api/devices

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Response body:**

```json
[
  {
    "id": "DEVICE_UUID",
    "agency_id": "AGENCY_UUID",
    "name": "Access sensors 1",
    "device_type": "ACCESS_SENSORS",
    "mqtt_client_id": "access-sensors-1",
    "mqtt_topic": "agency/AGENCY_UUID/device/access-sensors-1/sensor",
    "status": "ONLINE",
    "last_seen_at": "2026-08-25T10:00:00Z",
    "badge_zone_name": null,
    "heartbeat_seconds": 60
  }
]
```

**Success status:** `200 OK`
**Notes:** `badge_zone_name` is the AI zone a reader's badge scans are matched against
for the live map, or `null`. `heartbeat_seconds` (at least 10) is how often a
periodic publisher is expected to report; `null` means event-driven (a badge
reader or kiosk) and uptime is not tracked.
`MANAGER` and `TECHNICIAN` see devices from their own agency.

### POST /api/devices/agencies/{agency_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Request body:**

```json
{
  "name": "Access sensors 1",
  "device_type": "ACCESS_SENSORS",
  "mqtt_client_id": "access-sensors-1",
  "mqtt_topic": null
}
```

**Response body:**

```json
{
  "id": "DEVICE_UUID",
  "agency_id": "AGENCY_UUID",
  "name": "Access sensors 1",
  "device_type": "ACCESS_SENSORS",
  "mqtt_client_id": "access-sensors-1",
  "mqtt_topic": "agency/AGENCY_UUID/device/access-sensors-1/sensor",
  "status": "OFFLINE",
  "last_seen_at": null,
  "badge_zone_name": null,
  "heartbeat_seconds": null,
  "device_key": "DEVICE_SECRET_KEY"
}
```

**Success status:** `201 Created`
**Notes:** `device_key` is returned once only. Store it securely in the device;
it must never be committed to GitHub.

### GET /api/devices/{device_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Response body:** One device object.
**Success status:** `200 OK`

### PUT /api/devices/{device_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Request body:**

```json
{
  "name": "Access sensors 1",
  "device_type": "ACCESS_SENSORS",
  "mqtt_client_id": "access-sensors-1",
  "mqtt_topic": "agency/AGENCY_UUID/device/access-sensors-1/sensor",
  "status": "ONLINE",
  "badge_zone_name": "Entrance",
  "heartbeat_seconds": 60
}
```

**Response body:** Updated device object.
**Success status:** `200 OK`
**Notes:** All fields are optional. `badge_zone_name` is the AI zone a reader's badge scans are matched against
for the live map, or `null`. `heartbeat_seconds` (at least 10) is how often a
periodic publisher is expected to report; `null` means event-driven (a badge
reader or kiosk) and uptime is not tracked.


### POST /api/devices/{device_id}/rotate-key

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** Device object with a new `device_key`.
**Success status:** `200 OK`
**Notes:** The previous key becomes invalid immediately. Written to the audit log (`device_key_rotated`, with who did it).

### DELETE /api/devices/{device_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Response body:** Empty
**Success status:** `204 No Content`

---

## 10. Sensor thresholds

### GET /api/devices/{device_id}/thresholds

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Response body:**

```json
[
  {
    "id": "THRESHOLD_UUID",
    "device_id": "DEVICE_UUID",
    "sensor_type": "temperature",
    "unit": "C",
    "warning_max": 30,
    "critical_max": 40,
    "is_active": true
  }
]
```

**Success status:** `200 OK`

### PUT /api/devices/{device_id}/thresholds/{sensor_type}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Request body:**

```json
{
  "unit": "C",
  "warning_max": 30,
  "critical_max": 40,
  "is_active": true
}
```

**Response body:** Sensor threshold object.
**Success status:** `200 OK`
**Notes:** At least one limit is required. `warning_max` must be less than or
equal to `critical_max`.

### DELETE /api/devices/{device_id}/thresholds/{sensor_type}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `TECHNICIAN`
**Response body:** Empty
**Success status:** `204 No Content`

---

## 11. Cameras

### GET /api/agencies/{agency_id}/cameras

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[
  {
    "id": "CAMERA_UUID",
    "agency_id": "AGENCY_UUID",
    "name": "cam1",
    "stream_url": "rtsp://192.168.1.16:8554/stream",
    "status": "OFFLINE"
  }
]
```

**Success status:** `200 OK`
**Notes:** Non-`ADMIN` users can access only their own agency.

### POST /api/agencies/{agency_id}/cameras

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "name": "cam1",
  "stream_url": "rtsp://192.168.1.16:8554/stream"
}
```

**Response body:** Camera object.
**Success status:** `201 Created`
**Notes:** `ai_features` (optional, on create, update and every camera response) lists the AI detections this camera runs: any of `weapon`, `fire`, `wanted`, `emotion`. `null` (the default) means all of them, `[]` none. Only the cameras listing a detection are registered with that AI feature, so e.g. overhead cameras can run weapon/fire while a kiosk camera runs wanted/emotion. Person tracking and zones are chosen on their own screens. `name` is the exact source identifier used by the AI service. `stream_url` must be an `rtsp://`, `rtsps://`, `http://` or `https://` address with a host; anything else (a file path, another scheme) returns `422`. The same rule applies when `PUT /api/cameras/{camera_id}` changes `stream_url`.
Camera names are unique globally because the current AI source registry is
site-wide. `status` starts as `OFFLINE` and becomes `ONLINE` after the backend
receives a detection stream event.

### PUT /api/cameras/{camera_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "name": "cam1",
  "stream_url": "rtsp://192.168.1.16:8554/stream"
}
```

**Response body:** Camera object.
**Success status:** `200 OK`
**Notes:** The name is the key the AI service stores calibration and zones under. Renaming a camera that has a calibration or a zone there returns `409`; delete them first. A successful rename removes the old name from the AI service. Changing only `stream_url` has no such check.

### DELETE /api/cameras/{camera_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:** Empty
**Success status:** `204 No Content`
**Notes:** Alerts and emotion samples recorded for the camera are kept with `camera_id` set to `null`, and a counter linked to it through `emotion_camera_id` is unlinked. The camera is also removed from the AI service; if that cannot be reached the camera is still deleted.

---

## 12. AI weapon alert threshold

### GET /api/ai-alerts/thresholds/weapon

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "confidence": 0.6
}
```

**Success status:** `200 OK`

### PUT /api/ai-alerts/thresholds/weapon

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "confidence": 0.65
}
```

**Response body:**

```json
{
  "confidence": 0.65
}
```

**Success status:** `200 OK`
**Notes:** The value is global and must be strictly greater than `0` and less
than or equal to `1`. It is persisted in PostgreSQL and applied immediately
by the backend consumer. The same value is also set as the AI service's
`weapon.conf` (see `PATCH /api/ai/config`), so the detector stops reporting
below it, and the backend sets it again every time its consumer reconnects to
the AI service, so an AI restart does not lose it. Saving works while the AI
service is unreachable; the value is applied when it comes back. `422` if the
AI service refuses the value.

The backend consumes `WS /weapon/alerts/stream`, registers all configured
camera names and stream URLs with the AI service, filters detections below this
threshold, and creates or resolves `weapon` alerts linked to the matching
camera and agency.

---

## 13. Live AI streams

The frontend connects to these streams through the backend. It must use the
access token as the `token` query parameter:

```text
wss://backend.example/ws/alerts/weapon?token=JWT_ACCESS_TOKEN
```

The backend validates the token and role, then relays frames from the AI
service. The JWT is never forwarded to the AI service. Missing/invalid tokens
or unauthorized roles close the socket with WebSocket code `1008`. If the AI
service is unavailable, the backend closes the socket with code `1013`.

### GET /api/agencies/{agency_id}/alerts?alert_type=weapon

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Success status:** `200 OK`

**Response body:**

```json
[
  {
    "id": "ALERT_UUID",
    "agency_id": "AGENCY_UUID",
    "camera_id": "CAMERA_UUID",
    "camera_name": "camera-entrance",
    "device_id": null,
    "device_name": null,
    "alert_type": "weapon",
    "title": "string",
    "message": "string",
    "severity": "CRITICAL",
    "status": "OPEN",
    "created_at": "2026-10-04T10:00:00Z",
    "resolved_at": null
  }
]
```

**Notes:** Returns the alerts the backend has recorded, newest first, of every
kind: camera (`weapon`, `fire`, `wanted`, `emotion`), sensor (`temperature`,
`humidity`, `gas_co`, with `device_id`/`device_name` set) and system
(`ai_service_down`, `mqtt_down`), plus `zone_watch_down` (restricted zones unwatched, see section 23) and `intrusion` (someone not allowed in a
restricted zone, see section 23; its `tracking_id` is the tracked person, and
`tracking_id` is `null` on every other type). `alert_type` is optional and
filters the result.
`ADMIN` can read any agency; `MANAGER` and `SECURITY` only their own (403
otherwise). `camera_id` and `camera_name` are `null` once the camera has been
deleted. This is distinct from the live detection frames, which can include
detections that never became an alert.

### POST /api/alerts/{alert_id}/acknowledge

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Success status:** `200 OK`
**Response body:** the alert, same shape as one item of the list above, with
`status` `ACKNOWLEDGED`.
**Notes:** Marks an `OPEN` alert as seen. It stays active (a sensor still over
its limit keeps it) and resolves on its own when the cause clears.
Acknowledging an already acknowledged or resolved alert changes nothing.
`MANAGER` and `SECURITY` only for their own agency (`403`). `404` if the alert
does not exist.

### POST /api/alerts/{alert_id}/resolve

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Success status:** `200 OK`
**Response body:** the alert, with `status` `RESOLVED` and `resolved_at` set.
**Notes:** A person closes the incident. `weapon` and `wanted` alerts are only
ever closed this way: when the camera clears they stay active and their
`message` gains "plus visible depuis HH:MM UTC (camera)". A second camera
seeing the same weapon, or the same wanted name, updates the branch's active
incident instead of opening a second alert. Other types still resolve on
their own when the cause clears; resolving a sensor alert while its value is
still over the limit just reopens it on the next reading. `404` if the alert
does not exist, `403` outside the user's agency.

### POST /api/alerts/{alert_id}/its-staff

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{ "employee_id": "EMPLOYEE_UUID" }
```

**Success status:** `200 OK`
**Response body:** the alert, with `status` `RESOLVED`.
**Notes:** A false `intrusion` alarm: the "unknown" person is this employee
(the tracker lost them). Links the alert's `tracking_id` to the employee (as
`PUT /api/employees/{employee_id}/tracking` does) and resolves the alert,
appending "fausse alerte: NAME (personnel)" to its `message`. `422` for any
other alert type, `404` for an unknown alert or an employee of another
agency, `403` outside the user's agency.

### WS /ws/alerts/weapon

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**AI upstream:** `/weapon/alerts/stream`
**Frames:**

```json
{
  "type": "snapshot",
  "cameras": {
    "cam1": [
      {
        "class": "pistol",
        "confidence": 0.92,
        "bbox": [120, 80, 260, 310]
      }
    ]
  }
}
```

or an update:

```json
{
  "type": "update",
  "camera": "cam1",
  "detections": []
}
```

**Notes:** Relays the AI weapon-detection stream. `detections: []` means that
the camera is currently clear.

The weapon, fire, emotion and wanted alert sockets also receive a state frame
after the database transaction that opens, updates or resolves an alert has
committed:

```json
{
  "type": "alert_state",
  "event": "created",
  "id": "ALERT_UUID",
  "agency_id": "AGENCY_UUID",
  "camera_id": "CAMERA_UUID",
  "camera_name": "camera-entrance",
  "alert_type": "weapon",
  "severity": "CRITICAL",
  "status": "OPEN",
  "created_at": "2026-10-04T10:00:00Z",
  "resolved_at": null
}
```

`event` is `created`, `updated` or `resolved`. Each socket only receives its own
`alert_type`, and only for the cameras the user may see.

### WS /ws/alerts/fire

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**AI upstream:** `/fire/alerts/stream`
**Frames:** Same `snapshot` and `update` structure as the weapon stream.

```json
{
  "type": "update",
  "camera": "cam1",
  "detections": [
    {
      "class": "fire",
      "confidence": 0.88,
      "bbox": [120, 80, 260, 310]
    }
  ]
}
```

**Notes:** Relays fire-detection events from the AI service.

### WS /ws/alerts/emotion

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**AI upstream:** `/emotion/alerts/stream`
**Frames:** Same `snapshot` and `update` structure as the weapon stream.

```json
{
  "type": "update",
  "camera": "cam1",
  "detections": [
    {
      "class": "angry",
      "confidence": 0.81,
      "bbox": [120, 80, 260, 310]
    }
  ]
}
```

**Notes:** Relays emotion-detection events from the AI service.

### WS /ws/alerts/wanted

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**AI upstream:** `/wanted/alerts/stream`
**Frames:** Same `snapshot` and `update` structure as the weapon stream.

```json
{
  "type": "update",
  "camera": "cam1",
  "detections": [
    {
      "class": "PERSON-001",
      "confidence": 0.91,
      "bbox": [120, 80, 260, 310],
      "det_score": 0.97,
      "face_px": 120,
      "snapshot": "BASE64_JPEG"
    }
  ]
}
```

**Notes:** The `snapshot` field may contain a base64 JPEG for the highest-
confidence match. This stream is protected by the backend because it can carry
biometric information.

### WS /ws/occupancy

**Owner:** Backend
**Type:** WebSocket
**Roles:** `ADMIN`, `MANAGER`
**AI upstream:** `/zoning/occupancy/stream`
**Optional query parameter:** `threshold` (default `0`)

**Frames:**

```json
{
  "type": "snapshot",
  "zones": {
    "public-hall": {
      "count": 3,
      "points": [[120, 80], [260, 310]],
      "people_tracking_ready": true
    }
  }
}
```

or an update:

```json
{
  "type": "update",
  "zone": "public-hall",
  "count": 4,
  "points": [[120, 80], [260, 310]],
  "people_tracking_ready": true
}
```

**Notes:** The backend forwards `threshold` to the AI service but removes the
JWT query parameter. The stream is change-triggered, not a fixed heartbeat.
For a world zone, `people_tracking_ready: false` means that person tracking is
not ready yet; a `count` of `0` must not be interpreted as a confirmed empty
zone in that state.

---

## 14. Counters

### GET /api/agencies/{agency_id}/counters

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `AGENT`
**Response body:**

```json
[
  {
    "number": 0,
    "name": "string",
    "point_type": "COUNTER",
    "is_open": true,
    "id": "COUNTER_UUID",
    "service_id": "SERVICE_UUID",
    "emotion_camera_id": "EMOTION_CAMERA_UUID",
    "workstation_name": "string"
  }
]
```

**Success status:** `200 OK`
**Notes:** Ordered by `number`. `point_type` is `COUNTER` or `OFFICE`. Non-`ADMIN` users can access only their own agency (`403` otherwise). `404` if the agency does not exist.

### POST /api/agencies/{agency_id}/counters

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "number": 0,
  "name": "string",
  "point_type": "COUNTER",
  "is_open": true
}
```

**Response body:**

```json
{
  "number": 0,
  "name": "string",
  "point_type": "COUNTER",
  "is_open": true,
  "id": "COUNTER_UUID",
  "service_id": "SERVICE_UUID",
  "emotion_camera_id": "EMOTION_CAMERA_UUID",
  "workstation_name": "string"
}
```

**Success status:** `201 Created`
**Notes:** `number` must be at least 1 and unique within the agency (`409` otherwise). `name` is optional. `service_id` is assigned through `PATCH /api/counters/{counter_id}/service`, not here. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### PUT /api/counters/{counter_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "number": 0,
  "name": "string",
  "is_open": true,
  "emotion_camera_id": "EMOTION_CAMERA_UUID",
  "workstation_name": "string"
}
```

**Response body:**

```json
{
  "number": 0,
  "name": "string",
  "point_type": "COUNTER",
  "is_open": true,
  "id": "COUNTER_UUID",
  "service_id": "SERVICE_UUID",
  "emotion_camera_id": "EMOTION_CAMERA_UUID",
  "workstation_name": "string"
}
```

**Success status:** `200 OK`
**Notes:** Partial update: only the fields sent change, so a rename does not reopen a closed counter. `emotion_camera_id` links the camera used for satisfaction readings at that counter and `workstation_name` links an AI workstation. Errors: `404` if the counter or the linked camera does not exist, `403`, `409` if the new `number` is already used in the agency, `422` if `number` or `is_open` is sent as `null` or the camera belongs to another agency.

### DELETE /api/counters/{counter_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** `409` while an agent is assigned to the counter or a ticket is `CALLED` or `IN_SERVICE` there. Tickets that were served at it are kept and their `counter_id` becomes `null`.

### GET /api/agencies/{agency_id}/access-zones

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[
  {
    "name": "string",
    "zone_type": "PUBLIC",
    "is_private": false,
    "id": "ZONE_UUID"
  }
]
```

**Success status:** `200 OK`
**Notes:** Door access zones: the rooms an RFID door reader guards (`POST /internal/access/door-access`). Not the AI service's camera zones (`/api/zones`). Ordered by `name`. Which employees may enter is `authorized_zone_ids` on the employee. Non-`ADMIN` users can access only their own agency (`403` otherwise). `404` if the agency does not exist.

### POST /api/agencies/{agency_id}/access-zones

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "name": "string",
  "zone_type": "PUBLIC",
  "is_private": false
}
```

**Response body:**

```json
{
  "name": "string",
  "zone_type": "PUBLIC",
  "is_private": false,
  "id": "ZONE_UUID"
}
```

**Success status:** `201 Created`
**Notes:** `name` is 2 to 100 characters, trimmed, and unique within the agency ignoring case (`409` otherwise). `zone_type` defaults to `PUBLIC` and `is_private` to `false`. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### PUT /api/access-zones/{zone_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "name": "string",
  "zone_type": "PUBLIC",
  "is_private": false
}
```

**Response body:**

```json
{
  "name": "string",
  "zone_type": "PUBLIC",
  "is_private": false,
  "id": "ZONE_UUID"
}
```

**Success status:** `200 OK`
**Notes:** Partial update: only the fields sent change. `409` if the new `name` is already used in the agency, `422` if a field is sent as `null`, `404` if the zone does not exist, `403` outside the user's agency.

### DELETE /api/access-zones/{zone_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** Also removes every employee's access to the zone. A door reader still sending this `zone_id` then gets `404` and stays locked.

### Badge rooms: access mode and door camera

Every badge room (the access zones above) also carries `access_mode` and
`door_camera_id`, on create, update and in every response:

- `access_mode`: `"rfid"` (default) - the badge opens it; `"rfid_face"` - the
  badge AND the badge holder's face, checked once by `door_camera_id` when the
  badge is tapped (no continuous scanning).
- `door_camera_id`: a camera of the same agency (`404` unknown, `422` another
  agency's). Required for `"rfid_face"` (`422` otherwise). Deleting the camera
  sets it to `null`, after which the room refuses every badge until a camera
  is set again.

### GET /api/employees/{employee_id}/face

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
{ "enrolled": true, "photos": 2 }
```

**Success status:** `200 OK`
**Notes:** Whether the employee's face is enrolled for badge + face doors.
`MANAGER` only for their own agency (`403`); `404` unknown employee.

### POST /api/employees/{employee_id}/face

**Owner:** Backend
**Type:** REST (`multipart/form-data`, field `image`)
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
{ "enrolled": true, "photos": 2 }
```

**Success status:** `200 OK`
**Notes:** Adds one photo of the employee's face; several photos make the door
check more reliable. Stored in the AI face gallery under a key tied to the
employee, so a door compares the face with the badge holder exactly. `422`
when the photo does not contain exactly one face. Offboarding the employee
removes it.

### DELETE /api/employees/{employee_id}/face

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** Removes every enrolled photo of the employee. Their badge + face
doors stop opening for them until a face is enrolled again.

---

## 15. Announcements

### GET /api/announcements

**Owner:** Backend
**Type:** REST
**Roles:** any authenticated user
**Response body:**

```json
[
  {
    "id": "ANNOUNCEMENT_UUID",
    "agency_id": "AGENCY_UUID",
    "author_id": "AUTHOR_UUID",
    "title": "string",
    "message": "string",
    "created_at": "2026-01-01T09:00:00Z"
  }
]
```

**Success status:** `200 OK`
**Notes:** Newest first. Returns site-wide announcements (`agency_id` null) plus the caller's own agency's. An `ADMIN` sees every announcement.

### POST /api/announcements

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "title": "string",
  "message": "string",
  "agency_id": "AGENCY_UUID"
}
```

**Response body:**

```json
{
  "id": "ANNOUNCEMENT_UUID",
  "agency_id": "AGENCY_UUID",
  "author_id": "AUTHOR_UUID",
  "title": "string",
  "message": "string",
  "created_at": "2026-01-01T09:00:00Z"
}
```

**Success status:** `200 OK`
**Notes:** `agency_id: null` broadcasts to every agency and is allowed for `ADMIN` only (`403` otherwise). A `MANAGER` can post only to their own agency (`403`), `404` if the agency does not exist. `author_id` is the caller.

### DELETE /api/announcements/{announcement_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** `404` if it does not exist. A `MANAGER` can delete only their own agency's announcements; site-wide ones are `ADMIN` only (`403`).

---

## 16. Push notifications

### GET /api/push/public-key

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "public_key": "string",
  "push_enabled": true
}
```

**Success status:** `200 OK`
**Notes:** `public_key` is the VAPID key the browser passes to `PushManager.subscribe`. `push_enabled` is `false` when the server has no VAPID keys configured; email delivery is unaffected.

### POST /api/push/subscriptions

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "endpoint": "string",
  "keys": {
    "p256dh": "string",
    "auth": "string"
  }
}
```

**Success status:** `204 No Content`
**Notes:** Idempotent by `endpoint`: subscribing again from the same browser, or from another user on it, moves the subscription rather than duplicating it. Only `CRITICAL` alerts are pushed, to active `ADMIN` users and to the alert agency's `MANAGER` and `SECURITY` users.

### DELETE /api/push/subscriptions

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Parameters:** `endpoint` (query, required)
**Success status:** `204 No Content`
**Notes:** Removes the caller's subscription for that `endpoint`.

---

## 17. Manual device controls

### POST /api/controls/devices/{device_id}/command

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{
  "action": "string",
  "target": "string"
}
```

**Response body:**

```json
{
  "status": "string",
  "detail": "string"
}
```

**Success status:** `200 OK`
**Notes:** Blocks until the device acknowledges or `manual_control_ack_timeout_seconds` (default 10 s) elapses. `status` is `confirmed`, `failed` or `unknown` (no acknowledgement in time). Every call is written to the audit log. `404` if the device does not exist. Non-`ADMIN` users can access only their own agency (`403` otherwise). `action` must be one of the device type's commands (`GET /api/controls/commands`, case-insensitive); anything else is `422` and never reaches the device.

### GET /api/controls/commands

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{ "ACCESS_SENSORS": [{ "action": "lock", "label": "Lock" }, { "action": "unlock", "label": "Unlock" }] }
```

**Success status:** `200 OK`
**Notes:** Device type -> the commands a device of that type accepts, with
the button label, as listed in `contracts/device-commands.json` (the one list
the backend, the dashboard and the firmware share, `ingestion.md` 6b). A
device type that is not listed has no manual commands. A device answering
`unknown_action` makes the command result `failed` with a "firmware and
contract disagree" detail.

---

## 18. Climate and setup status

### GET /api/agencies/{agency_id}/climate/latest

**Owner:** Backend
**Type:** REST
**Roles:** any authenticated user
**Response body:**

```json
[
  {
    "device_id": "DEVICE_UUID",
    "device_name": "string",
    "sensor_type": "string",
    "value": 0.0,
    "unit": "string",
    "recorded_at": "2026-01-01T09:00:00Z"
  }
]
```

**Success status:** `200 OK`
**Notes:** The most recent reading for each device and `sensor_type` in the agency, ordered by device name then sensor type. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/agencies/{agency_id}/setup-status

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
{
  "items": [
    {
      "key": "string",
      "group": "string",
      "label": "string",
      "why": "string",
      "status": "done",
      "detail": "string",
      "link": "string"
    }
  ],
  "done": 0,
  "total": 0,
  "complete": true
}
```

**Success status:** `200 OK`
**Notes:** Derived checklist of what the branch still needs. `status` is `done`, `todo` or `unknown`; `complete` is true when every item is `done`. `link` is where the item is fixed, or `null`. Read-only. Non-`ADMIN` users can access only their own agency (`403` otherwise).

---

## 19. Insights

### GET /api/agencies/{agency_id}/insights/overview

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "alerts": {
    "open_by_severity": {
      "key": 0
    },
    "open_total": 0
  },
  "tickets": {
    "waiting": 0,
    "in_service": 0,
    "completed_today": 0,
    "cancelled_today": 0
  },
  "satisfaction": {
    "window_hours": 0,
    "total_samples": 0,
    "counts_by_emotion": {
      "key": 0
    },
    "positive_pct": 0.0,
    "neutral_pct": 0.0,
    "negative_pct": 0.0
  },
  "wait_times": {
    "window_hours": 0,
    "sample_count": 0,
    "avg_queue_wait_seconds": 0.0,
    "avg_walk_over_seconds": 0.0,
    "avg_service_duration_seconds": 0.0,
    "avg_total_seconds": 0.0
  },
  "visitor_recognition": {
    "window_days": 0,
    "new_visitors": 0,
    "returning_visitors": 0,
    "returning_pct": 0.0,
    "avg_days_between_visits": 0.0
  },
  "service_satisfaction": {
    "window_hours": 0,
    "tickets_with_coverage": 0,
    "total_samples": 0,
    "counts_by_emotion": {
      "key": 0
    },
    "positive_pct": 0.0,
    "neutral_pct": 0.0,
    "negative_pct": 0.0
  }
}
```

**Success status:** `200 OK`
**Notes:** Live summary for one agency. Percentages and averages are `null` when there is no data in the window. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/agencies/{agency_id}/insights/trends

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Parameters:** `days` (query, optional)
**Response body:**

```json
{
  "days": 0,
  "opening_seconds_per_day": 0,
  "daily": [
    {
      "date": "string",
      "tickets_completed": 0,
      "avg_service_seconds": 0.0,
      "service_samples": 0,
      "alerts_opened": 0,
      "critical_alerts_opened": 0,
      "satisfaction_samples": 0,
      "positive_pct": 0.0,
      "negative_pct": 0.0
    }
  ],
  "counters": [
    {
      "counter_id": "COUNTER_UUID",
      "number": 0,
      "name": "string",
      "tickets_completed": 0,
      "avg_service_seconds": 0.0,
      "service_samples": 0,
      "busy_seconds": 0,
      "utilization_pct": 0.0
    }
  ],
  "services": [
    {
      "service_id": "SERVICE_UUID",
      "name": "string",
      "tickets_completed": 0,
      "avg_queue_wait_seconds": 0.0,
      "avg_service_seconds": 0.0,
      "service_samples": 0,
      "is_slowest": true
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** `days` defaults to 7 (1 to 90). One `daily` row per day, plus per-counter and per-service breakdowns; `is_slowest` marks the service with the longest average service time. `opening_seconds_per_day` is the length of the agency's opening hours and is `null` when they are not set or closing is not after opening. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/agencies/{agency_id}/insights/satisfaction

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Parameters:** `hours` (query, optional)
**Response body:**

```json
{
  "window_hours": 0,
  "total_samples": 0,
  "counts_by_emotion": {
    "key": 0
  },
  "positive_pct": 0.0,
  "neutral_pct": 0.0,
  "negative_pct": 0.0
}
```

**Success status:** `200 OK`
**Notes:** `hours` defaults to 24 (1 to 720). Aggregate emotion mix for the agency, not a per-visitor score. Percentages are `null` when `total_samples` is 0. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/agencies/{agency_id}/insights/devices

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Parameters:** `days` (query, optional)
**Response body:**

```json
{
  "days": 0,
  "devices": [
    {
      "device_id": "DEVICE_UUID",
      "name": "string",
      "device_type": "string",
      "heartbeat_seconds": 0,
      "currently_online": true,
      "last_seen_at": "2026-01-01T09:00:00Z",
      "samples": 0,
      "online_pct": 0.0,
      "flaps": 0,
      "tracking_since": "2026-01-01T09:00:00Z",
      "daily": [
        {
          "date": "string",
          "online_pct": 0.0
        }
      ]
    }
  ],
  "untracked": [
    {
      "device_id": "DEVICE_UUID",
      "name": "string",
      "device_type": "string"
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** `days` defaults to 7 (1 to 90). Covers devices with `heartbeat_seconds` set; the others are listed under `untracked`. `online_pct` is `null` until a device has samples. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/agencies/{agency_id}/insights/access

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "window_minutes": 0,
  "threshold": 0,
  "doors": [
    {
      "device_id": "DEVICE_UUID",
      "name": "string",
      "failures_in_window": 0,
      "failures_24h": 0,
      "distinct_cards_in_window": 0,
      "by_reason": {
        "key": 0
      },
      "last_failure_at": "2026-01-01T09:00:00Z",
      "flagged": true,
      "recent": [
        {
          "occurred_at": "2026-01-01T09:00:00Z",
          "scanned_uid": "string",
          "reason": "string",
          "source": "string",
          "employee_name": "string"
        }
      ]
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** Failed badge attempts per door over the last 24 hours. `threshold` is the agency's access-failure threshold and is `null` when none is set. A door is `flagged` when `failures_in_window` reaches `threshold` within `window_minutes`; with no threshold nothing is flagged. `by_reason` counts failures per reason. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/insights/branches

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:**

```json
[
  {
    "agency_id": "AGENCY_UUID",
    "name": "string",
    "is_active": true,
    "overview": {
      "alerts": {
        "open_by_severity": {
          "key": 0
        },
        "open_total": 0
      },
      "tickets": {
        "waiting": 0,
        "in_service": 0,
        "completed_today": 0,
        "cancelled_today": 0
      },
      "satisfaction": {
        "window_hours": 0,
        "total_samples": 0,
        "counts_by_emotion": {
          "key": 0
        },
        "positive_pct": 0.0,
        "neutral_pct": 0.0,
        "negative_pct": 0.0
      },
      "wait_times": {
        "window_hours": 0,
        "sample_count": 0,
        "avg_queue_wait_seconds": 0.0,
        "avg_walk_over_seconds": 0.0,
        "avg_service_duration_seconds": 0.0,
        "avg_total_seconds": 0.0
      },
      "visitor_recognition": {
        "window_days": 0,
        "new_visitors": 0,
        "returning_visitors": 0,
        "returning_pct": 0.0,
        "avg_days_between_visits": 0.0
      },
      "service_satisfaction": {
        "window_hours": 0,
        "tickets_with_coverage": 0,
        "total_samples": 0,
        "counts_by_emotion": {
          "key": 0
        },
        "positive_pct": 0.0,
        "neutral_pct": 0.0,
        "negative_pct": 0.0
      }
    }
  }
]
```

**Success status:** `200 OK`
**Notes:** `overview` is the same object as `GET /api/agencies/{agency_id}/insights/overview`, for every agency, for side-by-side comparison. `ADMIN` only.

---

## 20. Reports

### GET /api/agencies/{agency_id}/report

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Parameters:** `start` (query, required), `end` (query, required)
**Response body:**

```json
{
  "agency_id": "AGENCY_UUID",
  "name": "string",
  "period": {
    "start": "2026-01-01",
    "end": "2026-01-01",
    "days": 0
  },
  "generated_at": "2026-01-01T09:00:00Z",
  "tickets": {
    "created": 0,
    "completed": 0,
    "cancelled": 0,
    "no_show": 0,
    "unfinished": 0,
    "completion_pct": 0.0,
    "visitors_served": 0
  },
  "wait_times": {
    "window_hours": 0,
    "sample_count": 0,
    "avg_queue_wait_seconds": 0.0,
    "avg_walk_over_seconds": 0.0,
    "avg_service_duration_seconds": 0.0,
    "avg_total_seconds": 0.0
  },
  "satisfaction": {
    "window_hours": 0,
    "total_samples": 0,
    "counts_by_emotion": {
      "key": 0
    },
    "positive_pct": 0.0,
    "neutral_pct": 0.0,
    "negative_pct": 0.0
  },
  "service_satisfaction": {
    "window_hours": 0,
    "tickets_with_coverage": 0,
    "total_samples": 0,
    "counts_by_emotion": {
      "key": 0
    },
    "positive_pct": 0.0,
    "neutral_pct": 0.0,
    "negative_pct": 0.0
  },
  "alerts": {
    "opened_total": 0,
    "opened_by_severity": {
      "key": 0
    },
    "opened_by_type": {
      "key": 0
    },
    "resolved": 0,
    "avg_resolve_minutes": 0.0
  },
  "busiest": {
    "day": "2026-01-01",
    "day_tickets": 0,
    "hour_utc": 0,
    "hour_tickets": 0
  },
  "trends": {
    "days": 0,
    "opening_seconds_per_day": 0,
    "daily": [
      {
        "date": "string",
        "tickets_completed": 0,
        "avg_service_seconds": 0.0,
        "service_samples": 0,
        "alerts_opened": 0,
        "critical_alerts_opened": 0,
        "satisfaction_samples": 0,
        "positive_pct": 0.0,
        "negative_pct": 0.0
      }
    ],
    "counters": [
      {
        "counter_id": "COUNTER_UUID",
        "number": 0,
        "name": "string",
        "tickets_completed": 0,
        "avg_service_seconds": 0.0,
        "service_samples": 0,
        "busy_seconds": 0,
        "utilization_pct": 0.0
      }
    ],
    "services": [
      {
        "service_id": "SERVICE_UUID",
        "name": "string",
        "tickets_completed": 0,
        "avg_queue_wait_seconds": 0.0,
        "avg_service_seconds": 0.0,
        "service_samples": 0,
        "is_slowest": true
      }
    ]
  }
}
```

**Success status:** `200 OK`
**Notes:** `start` and `end` are inclusive `YYYY-MM-DD` dates. `422` if `end` is before `start`, if `end` is in the future, or if the period exceeds 366 days. Averages and percentages are `null` when there is no data. `busiest.hour_utc` is the busiest hour in UTC. Non-`ADMIN` users can access only their own agency (`403` otherwise).

### GET /api/reports/branches

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Parameters:** `start` (query, required), `end` (query, required)
**Response body:**

```json
{
  "period": {
    "start": "2026-01-01",
    "end": "2026-01-01",
    "days": 0
  },
  "branches": [
    {
      "agency_id": "AGENCY_UUID",
      "name": "string",
      "period": {
        "start": "2026-01-01",
        "end": "2026-01-01",
        "days": 0
      },
      "generated_at": "2026-01-01T09:00:00Z",
      "tickets": {
        "created": 0,
        "completed": 0,
        "cancelled": 0,
        "no_show": 0,
        "unfinished": 0,
        "completion_pct": 0.0,
        "visitors_served": 0
      },
      "wait_times": {
        "window_hours": 0,
        "sample_count": 0,
        "avg_queue_wait_seconds": 0.0,
        "avg_walk_over_seconds": 0.0,
        "avg_service_duration_seconds": 0.0,
        "avg_total_seconds": 0.0
      },
      "satisfaction": {
        "window_hours": 0,
        "total_samples": 0,
        "counts_by_emotion": {
          "key": 0
        },
        "positive_pct": 0.0,
        "neutral_pct": 0.0,
        "negative_pct": 0.0
      },
      "service_satisfaction": {
        "window_hours": 0,
        "tickets_with_coverage": 0,
        "total_samples": 0,
        "counts_by_emotion": {
          "key": 0
        },
        "positive_pct": 0.0,
        "neutral_pct": 0.0,
        "negative_pct": 0.0
      },
      "alerts": {
        "opened_total": 0,
        "opened_by_severity": {
          "key": 0
        },
        "opened_by_type": {
          "key": 0
        },
        "resolved": 0,
        "avg_resolve_minutes": 0.0
      },
      "busiest": {
        "day": "2026-01-01",
        "day_tickets": 0,
        "hour_utc": 0,
        "hour_tickets": 0
      },
      "trends": null
    }
  ],
  "totals": {
    "agency_id": "all",
    "name": "All branches",
    "period": {
      "start": "2026-01-01",
      "end": "2026-01-01",
      "days": 0
    },
    "generated_at": "2026-01-01T09:00:00Z",
    "tickets": {
      "created": 0,
      "completed": 0,
      "cancelled": 0,
      "no_show": 0,
      "unfinished": 0,
      "completion_pct": 0.0,
      "visitors_served": 0
    },
    "wait_times": {
      "window_hours": 0,
      "sample_count": 0,
      "avg_queue_wait_seconds": 0.0,
      "avg_walk_over_seconds": 0.0,
      "avg_service_duration_seconds": 0.0,
      "avg_total_seconds": 0.0
    },
    "satisfaction": {
      "window_hours": 0,
      "total_samples": 0,
      "counts_by_emotion": {
        "key": 0
      },
      "positive_pct": 0.0,
      "neutral_pct": 0.0,
      "negative_pct": 0.0
    },
    "service_satisfaction": {
      "window_hours": 0,
      "tickets_with_coverage": 0,
      "total_samples": 0,
      "counts_by_emotion": {
        "key": 0
      },
      "positive_pct": 0.0,
      "neutral_pct": 0.0,
      "negative_pct": 0.0
    },
    "alerts": {
      "opened_total": 0,
      "opened_by_severity": {
        "key": 0
      },
      "opened_by_type": {
        "key": 0
      },
      "resolved": 0,
      "avg_resolve_minutes": 0.0
    },
    "busiest": {
      "day": "2026-01-01",
      "day_tickets": 0,
      "hour_utc": 0,
      "hour_tickets": 0
    },
    "trends": null
  }
}
```

**Success status:** `200 OK`
**Notes:** Same query rules as the single-agency report. `branches` holds one report per agency in the same shape as `GET /api/agencies/{agency_id}/report`; `trends` is always `null` here; use the single-agency report for trends. `totals` (`agency_id` `"all"`) is computed from all agencies' raw data together, not by averaging the per-branch figures. `ADMIN` only.

---

## 21. People tracking and camera frames

### GET /api/employees/roster

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[{ "employee_id": "EMPLOYEE_UUID", "full_name": "Sara B", "agency_id": "AGENCY_UUID" }]
```

**Success status:** `200 OK`
**Notes:** Active employees' names, for picking who a tracked person is (the
live map, an intrusion alert's "It's staff"). `ADMIN` every agency, others
their own.

### PUT /api/employees/{employee_id}/tracking

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Request body:**

```json
{ "tracking_id": "12" }
```

**Success status:** `204 No Content`
**Notes:** Manual fix from the live map: this tracked person is this
employee (the tracker lost them and picked them up as someone new). Whoever
else held that `tracking_id` loses it. Written to the audit log
(`track_linked`). `404` unknown employee, `403` another agency's, `422` an inactive
employee. Offboarding an employee drops their link; only active employees count
as staff.

### DELETE /api/employees/tracked/{tracking_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Success status:** `204 No Content`
**Notes:** Manual fix: this tracked person is not staff (a wrong link). Clears
it from the employee holding it, in the caller's agency (`ADMIN`: any).
Audit log `track_unlinked`. No error if nobody held it.

### GET /api/employees/tracked

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[
  {
    "employee_id": "EMPLOYEE_UUID",
    "full_name": "string",
    "tracking_id": "TRACKING_UUID"
  }
]
```

**Success status:** `200 OK`
**Notes:** Employees currently linked to a live track, for labelling the live map. Non-`ADMIN` users see only their own agency.

### GET /api/tickets/tracked

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[
  {
    "ticket_id": "TICKET_UUID",
    "ticket_number": "string",
    "tracking_id": "TRACKING_UUID"
  }
]
```

**Success status:** `200 OK`
**Notes:** Tickets that are linked to a live track and are not yet `COMPLETED`, `CANCELLED` or `NO_SHOW`, for labelling the live map. Non-`ADMIN` users see only their own agency.

### GET /api/people/status

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "phase": "running",
  "warnings": [],
  "error": null,
  "person_scale": 33.1,
  "room": {},
  "fps": 25.0,
  "cams_bootstrapped": [
    "CAMERA_UUID"
  ],
  "gates_loaded": 2,
  "active_tracks": 3
}
```

**Success status:** `200 OK`
**Notes:** Status of the AI person-tracking service. `phase` is `idle`, `bootstrapping`, `running` or `error`; `active_tracks` is `null` until it is running. `cams_bootstrapped` lists camera ids, or is `null`. Not agency-scoped: tracking covers the whole site. `503` if the AI service is unreachable.

### GET /api/people/sources

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
{
  "sources_known": [
    "CAMERA_UUID"
  ],
  "calibrated": [
    "CAMERA_UUID"
  ],
  "aligned": [
    "CAMERA_UUID"
  ]
}
```

**Success status:** `200 OK`
**Notes:** Camera ids known to the tracker, and which of them are calibrated and aligned. Not agency-scoped. The tracker is site-wide, but a non-`ADMIN` only sees their own agency's cameras in `sources_known`/`calibrated`/`aligned` (here, in `GET /api/people/status`'s `cams_bootstrapped` and in the `POST` answer), and may only add or remove their own agency's cameras (`403`).

### POST /api/people/sources

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "camera_ids": [
    "CAMERA_UUID"
  ]
}
```

**Response body:**

```json
{
  "sources_known": [
    "CAMERA_UUID"
  ],
  "calibrated": [
    "CAMERA_UUID"
  ],
  "aligned": [
    "CAMERA_UUID"
  ],
  "warnings": []
}
```

**Success status:** `200 OK`
**Notes:** Registers cameras with the tracker using their configured `stream_url`. Unknown cameras and cameras without a `stream_url` are skipped. Adding a camera re-triggers the tracker's bootstrap. `warnings` comes from the AI service.

### DELETE /api/people/sources/{camera_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
{
  "camera": "CAMERA_UUID",
  "deleted": true
}
```

**Success status:** `200 OK`
**Notes:** Stops tracking this camera. `404` if the camera does not exist.

### GET /api/cameras/{camera_id}/frame

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Parameters:** `native` (query, optional, default `false`), `format` (query, optional, default `jpeg`), `quality` (query, optional, default `75`)
**Success status:** `200 OK`
**Notes:** Returns the camera's latest frame as an image (not JSON), fetched from the AI service. Without `native` the frame is the detector-scaled one, which is the coordinate space alert boxes use. With `native=true` it is the camera's full resolution and `format` and `quality` are ignored; calibration needs this one. `404` if the camera does not exist. Non-`ADMIN` users can access only their own agency (`403` otherwise).

---

## 22. Calibration

Calibration lives in the site-wide AI service and is proxied (`503` if unreachable, its own `4xx` passed through). Every calibration is about a camera, and cameras belong to agencies: a `MANAGER` only reads and changes their own agency's cameras (`403` for another agency's camera; `GET` lists only theirs). The entry gates are one site-wide list: a `MANAGER` sees only the gates on their own cameras, and saving or clearing replaces only those, keeping every other agency's. Camera keys and values are camera ids; the backend translates them to and from the AI service's camera names.

### GET /api/calibration

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "camera_id": "CAMERA_UUID",
    "Hinv": [
      [
        0.0,
        0.0,
        0.0
      ],
      [
        0.0,
        0.0,
        0.0
      ],
      [
        0.0,
        0.0,
        1.0
      ]
    ],
    "aligned": true,
    "diagnostics": {
      "aligned": true,
      "aligned_to": "CAMERA_UUID"
    }
  }
]
```

**Success status:** `200 OK`
**Notes:** One entry per calibrated camera that exists in this system. `aligned` is copied from `diagnostics.aligned`. The remaining fields are passed through from the AI service.

### POST /api/calibration/rect

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "camera_id": "CAMERA_UUID",
  "points": [
    [
      120,
      430
    ],
    [
      980,
      410
    ],
    [
      1010,
      700
    ],
    [
      95,
      720
    ]
  ],
  "img_w": 1920,
  "img_h": 1080
}
```

**Response body:**

```json
{
  "n_points": 4,
  "px_err_mean": 0.0,
  "px_err_max": 0.0,
  "aspect_source": "string",
  "inferred_aspect": 1.78,
  "aspect_stability_std": 0.02,
  "aspect_confident": true,
  "calib_res": [
    1920,
    1080
  ],
  "aligned": false,
  "note": "string"
}
```

**Success status:** `200 OK`
**Notes:** Calibrates one camera from 4 clicked points around a real rectangle, in order. `points` are pixel coordinates in the native frame (`GET /api/cameras/{camera_id}/frame?native=true`). `404` if the camera does not exist, `422` from the AI service if the points are not exactly 4 or are nearly collinear. A rectangle fit always reports near-zero `px_err_*`; it is not a validation. `aligned` stays `false` until `/api/calibration/align` runs. Both this and `POST /api/calibration/align` also re-save every world zone from the pixels it was drawn on, so its floor outline follows the new calibration; the response gains `"zones": {"redrawn": [names], "not_redrawn": [names]}` (a zone whose camera is not calibrated and aligned yet, or has no other camera in its branch, keeps its old outline).

### POST /api/calibration/align

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "points": [
    {
      "CAMERA_UUID": [
        512,
        300
      ],
      "CAMERA_2_UUID": [
        140,
        290
      ]
    }
  ]
}
```

**Response body:**

```json
{
  "reference": "CAMERA_UUID",
  "results": {
    "CAMERA_UUID": {
      "aligned": true,
      "reference": true,
      "n_points": null,
      "via": null
    },
    "CAMERA_2_UUID": {
      "aligned": true,
      "reference": false,
      "n_points": 2,
      "via": "CAMERA_UUID",
      "fit": "homography"
    }
  },
  "results_warning": null,
  "residual_checks": [
    {
      "pairs": [
        {
          "cam_a": "CAMERA_UUID",
          "cam_b": "CAMERA_2_UUID",
          "distance_cm": 0.0
        }
      ]
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** Aligns every calibrated camera into one shared floor frame. `points` is the full accumulated list of shared-point observations, each an object mapping `camera_id` to a pixel `[x, y]`, not a delta. Check `results` per camera: a camera that could not be reached comes back with `aligned: false` and an `error`, and the call still returns `200`. `400` from the AI service if fewer than 2 cameras are calibrated. Also redraws the world zones, as `POST /api/calibration/rect` does (`zones` in the response).

### POST /api/calibration/cross_check

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "points": {
    "CAMERA_UUID": [
      512,
      300
    ],
    "CAMERA_2_UUID": [
      140,
      290
    ]
  }
}
```

**Response body:**

```json
{
  "worlds": {
    "CAMERA_UUID": [
      45.7,
      -45.6
    ],
    "CAMERA_2_UUID": [
      45.7,
      -45.6
    ]
  },
  "pairs": [
    {
      "cam_a": "CAMERA_UUID",
      "cam_b": "CAMERA_2_UUID",
      "distance_cm": 0.0
    }
  ]
}
```

**Success status:** `200 OK`
**Notes:** Read-only check: send one clicked point per camera for the same real-world spot (at least 2 aligned cameras) and get back how far apart the cameras place it. Use points that were not used to align. `422` from the AI service if a camera is uncalibrated or unaligned. `worlds` values are floor centimetres.

### GET /api/calibration/gates

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  [
    100.0,
    250.0
  ],
  [
    140.0,
    260.0
  ]
]
```

**Success status:** `200 OK`
**Notes:** Entry and exit points in floor centimetres, used by the tracker. `[]` if none are set.

### POST /api/calibration/gates

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "gates": [
    {
      "camera": "CAMERA_UUID",
      "points": [
        [
          120,
          430
        ],
        [
          140,
          460
        ]
      ]
    }
  ]
}
```

**Response body:**

```json
[
  [
    100.0,
    250.0
  ],
  [
    140.0,
    260.0
  ]
]
```

**Success status:** `200 OK`
**Notes:** Replaces the whole gate list. Each referenced camera must already be calibrated (`422` otherwise); `points` are pixel coordinates in that camera's native frame. `404` if a camera does not exist. Returns the saved gates in floor centimetres.

### DELETE /api/calibration/gates

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `200 OK`
**Notes:** Removes every gate. The response body is `null`.

### DELETE /api/calibration/{camera_id}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `200 OK`
**Notes:** Removes one camera's calibration. The response body is `null`. `404` if the camera does not exist or is not calibrated.

---

## 23. Zones and workstations

Zones and workstations live in the AI service (`503` if unreachable, its own `4xx` passed through) and are filtered to the caller's agency through the camera each zone was drawn on. `ADMIN` sees all.

### GET /api/zones

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "name": "lobby",
    "mode": "pixel",
    "camera_id": "CAMERA_UUID",
    "polygon_px": [
      [
        100,
        200
      ],
      [
        400,
        200
      ],
      [
        400,
        500
      ],
      [
        100,
        500
      ]
    ],
    "polygon_m": null,
    "converted_from": null
  },
  {
    "name": "hall",
    "mode": "world",
    "camera_id": null,
    "polygon_px": null,
    "polygon_m": [
      [
        1.0,
        2.0
      ],
      [
        4.0,
        2.0
      ],
      [
        4.0,
        5.0
      ],
      [
        1.0,
        5.0
      ]
    ],
    "converted_from": {
      "camera": "string",
      "polygon_px": [
        [
          100,
          200
        ]
      ]
    }
  }
]
```

**Success status:** `200 OK`
**Notes:** A `pixel` zone belongs to one camera and has `polygon_px` (image pixels). A `world` zone spans cameras and has `polygon_m` (metres) and `converted_from` (the camera and pixel polygon it was drawn on); `camera_id` and `polygon_px` are then `null`. Every zone also has `restriction` (`anyone`, `staff` or `nobody`, see `PUT /api/zones/{name}/restriction`).

### PUT /api/zones/{name}/restriction

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{ "restriction": "staff" }
```

**Response body:**

```json
{ "name": "Back office", "restriction": "staff", "warnings": [] }
```

**Success status:** `200 OK`
**Notes:** Who may stand in the zone. `anyone` (default, no watch);
`staff`: only tracked people linked to an employee of the zone's agency (a
badge scan links them, `PUT /api/employees/{employee_id}/tracking` fixes a
wrong one); `nobody`: no one at all. Anyone not allowed who stays more than 5
seconds opens one CRITICAL `intrusion` alert per person, titled
"Intrusion: ZONE", which stays open until a person resolves it (or
`POST /api/alerts/{alert_id}/its-staff`). Resolving it while that person is
still in the zone keeps them silent there until they leave; coming back later
opens a new alert. Only a `world` zone can be
restricted (`422` for a pixel zone): the check compares tracked floor
positions with its floor outline. `404` unknown zone, `403` another agency's.
`warnings` lists setup problems that make the rule misfire, e.g. `staff` while
no badge reader of the agency has a badge zone (nobody can then be recognised
as staff, so everyone in the zone raises an alert).
While the agency has restricted zones and people tracking is stopped or
silent for longer than the AI-down grace period, one CRITICAL
`zone_watch_down` alert is open for it ("no intrusion can be detected"); it
resolves on its own when tracking is back.
Deleting the zone removes its rule.

### GET /api/zones/intruders

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`, `SECURITY`
**Response body:**

```json
[{ "alert_id": "ALERT_UUID", "tracking_id": "12", "title": "Intrusion: Back office" }]
```

**Success status:** `200 OK`
**Notes:** The tracked people with an active `intrusion` alert, for the live
map's marker. `ADMIN` sees every agency, others their own.

### POST /api/zones

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "name": "lobby",
  "camera_id": "CAMERA_UUID",
  "extra_camera_ids": [],
  "polygon": [
    [
      100,
      200
    ],
    [
      400,
      200
    ],
    [
      400,
      500
    ],
    [
      100,
      500
    ]
  ]
}
```

**Response body:**

```json
{
  "name": "lobby",
  "mode": "pixel",
  "camera_id": "CAMERA_UUID",
  "polygon_px": [
    [
      100,
      200
    ],
    [
      400,
      200
    ],
    [
      400,
      500
    ],
    [
      100,
      500
    ]
  ],
  "polygon_m": null,
  "converted_from": null,
  "warnings": []
}
```

**Success status:** `200 OK`
**Notes:** `polygon` is in pixels of `camera_id`'s native frame. With only `camera_id` the zone is `pixel` and needs no calibration. With `extra_camera_ids` it is `world` and the drawing camera must be calibrated and aligned (`422` otherwise). Every camera needs a `stream_url` (`422` otherwise). Posting an existing `name` overwrites it. A world zone reads live tracked positions, so `warnings` says when person tracking is not running and the zone would count 0. `404` if a camera does not exist, `403` outside the caller's agency.

### DELETE /api/zones/{name}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `200 OK`
**Notes:** The response body is `null`. `404` if the zone does not exist, `403` if it belongs to another agency.

### GET /api/workstations

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "name": "desk1",
    "zone": "lobby",
    "status": "present",
    "since": 1787600123.4,
    "zone_known": true
  }
]
```

**Success status:** `200 OK`
**Notes:** A workstation is a name bound to an existing zone. `status` is `unknown`, `present` or `away`; `since` is a Unix timestamp in seconds of the last change; `zone_known` is `false` until the zone has been measured once.

### POST /api/workstations

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "name": "desk1",
  "zone": "lobby"
}
```

**Response body:**

```json
{
  "name": "desk1",
  "zone": "lobby",
  "status": "unknown",
  "since": 1787600000.0,
  "zone_known": false
}
```

**Success status:** `200 OK`
**Notes:** `zone` must already exist (`422` otherwise) and, for a non-`ADMIN` user, belong to their agency (`403`).

### DELETE /api/workstations/{name}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `200 OK`
**Notes:** The response body is `null`. `404` if it does not exist, `403` if its zone belongs to another agency.

---

## 24. Face enrollment and watchlist

Two separate galleries held by the AI service: employees (`/api/face`) and the wanted-person watchlist (`/api/watchlist`). Enrolling into one never touches the other. Both galleries are site-wide in the AI service; the backend records which agency added each name. A `MANAGER` only lists, re-enrolls and deletes their own agency's names (`403` otherwise); a name from before this rule, with no recorded agency, counts as theirs only while the site has a single active agency. A new name is free to take. An `ADMIN` sees and changes every name, and may give `agency_id` (form field) when adding to the watchlist (none = for every agency). A watchlist match still alerts on every camera. Every add and delete is written to the audit log (`watchlist_added`, `watchlist_removed`, `face_enrolled`, `face_removed`). The watchlist threshold is one value for every agency: a `MANAGER` may change it only on a single-agency site (`403` otherwise), audit `watchlist_threshold_changed`. Every route here returns `503` if the AI service is unreachable and passes the AI service's own `4xx` status and `detail` through. Upload requests are `multipart/form-data`.

### GET /api/face/faces

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "name": "employee1",
    "embeddings_count": 2
  }
]
```

**Success status:** `200 OK`
**Notes:** Embedding vectors are never returned, only a count. Badge + face door faces (`emp-<employee id>`, managed through `/api/employees/{employee_id}/face`) are not listed.

### POST /api/face/enroll

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body (multipart/form-data):**

```json
{
  "name": "employee1",
  "image": "(file)"
}
```

**Response body:**

```json
{
  "name": "employee1",
  "embeddings_count": 1
}
```

**Success status:** `200 OK`
**Notes:** `image` must contain exactly one face (`422` if zero or several, `400` if the image cannot be decoded). Enrolling the same `name` again adds another embedding; `embeddings_count` is cumulative. A `name` starting with `emp-` is reserved for badge + face door faces (`422`).

### DELETE /api/face/faces/{name}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** Removes the person's whole entry. `404` if the name is unknown. `422` for a badge + face door face (`emp-...`): those are removed from the employee form.

### GET /api/watchlist

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
[
  {
    "name": "SUSPECT-2024-114",
    "embeddings_count": 2
  }
]
```

**Success status:** `200 OK`

### POST /api/watchlist

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body (multipart/form-data):**

```json
{
  "name": "SUSPECT-2024-114",
  "image": "(file)"
}
```

**Response body:**

```json
{
  "name": "SUSPECT-2024-114",
  "embeddings_count": 1
}
```

**Success status:** `200 OK`
**Notes:** Same rules as `POST /api/face/enroll`. `name` accepts letters, digits, space and `. _ + -`, 1 to 80 characters (`422` otherwise).

### DELETE /api/watchlist/{name}

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Success status:** `204 No Content`
**Notes:** `404` if the name is unknown.

### GET /api/watchlist/threshold

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Response body:**

```json
{
  "threshold": 0.5,
  "min_face_px": 30,
  "startup_default": {
    "threshold": 0.5,
    "min_face_px": 30
  },
  "floor": 0.25,
  "watchlist_size": 3,
  "embeddings_total": 7,
  "applies_within_seconds": 2.0
}
```

**Success status:** `200 OK`
**Notes:** `floor` is the lowest accepted `threshold`. `startup_default` is the value the AI service booted with.

### PUT /api/watchlist/threshold

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`, `MANAGER`
**Request body:**

```json
{
  "threshold": 0.58
}
```

**Response body:**

```json
{
  "threshold": 0.58,
  "min_face_px": 30,
  "startup_default": {
    "threshold": 0.5,
    "min_face_px": 30
  },
  "floor": 0.25,
  "watchlist_size": 3,
  "embeddings_total": 7,
  "applies_within_seconds": 2.0
}
```

**Success status:** `200 OK`
**Notes:** Send `threshold`, `min_face_px` or both. Applies on the next detection cycle. `threshold` is also stored in PostgreSQL and set again every time the backend reconnects to the AI service, so an AI restart does not lose it; `min_face_px` is not stored and returns to the AI service's own setting after a restart. `422` below the `floor`. Returns the current values in the same shape as `GET /api/watchlist/threshold`.

---

## 25. AI service configuration

Detector tuning for the AI service, site-wide (not per agency). `ADMIN` only. Every route returns `503` if the AI service is unreachable and passes the AI service's own `4xx` status and `detail` through.

### GET /api/ai/config

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:**

```json
{
  "config": {
    "weapon": { "conf": 0.25, "imgsz": 640, "update_interval": 2.0 },
    "fire": { "conf": 0.25, "imgsz": 1280, "update_interval": 2.0 },
    "wanted": { "threshold": 0.5, "min_face_px": 30, "confirm_cycles": 2, "hold_cycles": 5 },
    "face": { "pack": "buffalo_s" }
  },
  "apply_modes": {
    "weapon": { "conf": "live", "imgsz": "live", "update_interval": "live" },
    "wanted": { "det_size": "restart" },
    "person_tracking": { "gate_pw": "next_start" }
  },
  "startup_config": {
    "weapon": { "conf": 0.25, "imgsz": 640, "update_interval": 2.0 }
  },
  "pending_restart": {}
}
```

**Success status:** `200 OK`
**Notes:** `config` holds the values the AI service is running now, grouped by feature (the example shows a subset of features and keys). `apply_modes` says how each key can be changed: `live` takes effect within that feature's `update_interval`, `next_start` is stored now and used the next time person tracking bootstraps, `restart` takes effect only after the AI service restarts. `startup_config` is what the AI service's own config file said at boot, so a live change shows as a difference. `pending_restart` lists restart-mode values already saved to the file but not running yet.

### PATCH /api/ai/config

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Request body:**

```json
{
  "changes": {
    "weapon": { "conf": 0.4, "update_interval": 3.0 }
  },
  "persist": false
}
```

**Response body:**

```json
{
  "applied": {
    "weapon": {
      "conf": { "value": 0.4, "mode": "live" },
      "update_interval": { "value": 3.0, "mode": "live" }
    }
  },
  "pending_restart": {},
  "previous": { "weapon": { "conf": 0.25, "update_interval": 2.0 } },
  "persisted": false
}
```

**Success status:** `200 OK`
**Notes:** `changes` maps a feature to the keys to change. `persist` defaults to `false`: the change lasts until the AI service restarts. With `persist: true` it is also written to the AI service's config file, and `restart`-mode keys are accepted and returned under `pending_restart`. Without `persist`, a `restart`-mode key is refused. The change is all-or-nothing: if any value is invalid the response is `422` with `detail` `{"message": "config not changed", "errors": ["..."]}` listing every problem, and nothing is applied. Unknown features or keys, wrong types and out-of-range values are all `422`. `422` also when `changes` is missing. `weapon.conf`, `wanted.threshold` and `fire.conf` are alert thresholds: the backend also stores them and sets them again whenever the AI service restarts, even without `persist`. `weapon.conf` and `wanted.threshold` are the same values as `PUT /api/ai-alerts/thresholds/weapon` and `PUT /api/watchlist/threshold`. Each successful change is written to the audit log as `ai_config_changed`, with the changes and the previous values.

### POST /api/ai/config/reload

**Owner:** Backend
**Type:** REST
**Roles:** `ADMIN`
**Response body:**

```json
{
  "applied": {
    "fire": { "conf": { "value": 0.6, "mode": "live" } }
  },
  "pending_restart": { "face": { "pack": "buffalo_l" } },
  "previous": { "fire": { "conf": 0.25 } },
  "persisted": false
}
```

**Success status:** `200 OK`
**Notes:** Re-reads the AI service's config file and applies what differs from what is running: `live` keys now, `restart` keys reported under `pending_restart`. All-or-nothing: a bad value in the file returns `422` and applies nothing. Written to the audit log as `ai_config_reloaded`.

---

## 26. System

### GET /health

**Owner:** Backend
**Type:** REST
**Roles:** Public
**Response body:**

```json
{
  "status": "ok"
}
```

**Success status:** `200 OK`

---

## Permission summary

- **ADMIN:** global access to agencies, users, employees, visitors, tickets,
  attendance, services and IoT resources.
- **MANAGER:** access restricted to their own agency; can manage agency
  resources according to the endpoint role list.
- **AGENT:** manages visitors, tickets and can read services and service
  points.
- **SECURITY:** manages attendance and visitors.
- **TECHNICIAN:** manages IoT devices and sensor thresholds.
