# Ingestion Contract (internal)

Contract between the backend and the hardware/IoT layer. This document defines
the payloads, topics and authentication required by the SmartAgency backend.

The owner of the producing subsystem maintains the corresponding contract
entry. Any change that removes an endpoint or changes/removes an existing field
must prefix the PR title with `BREAKING:` and be announced in `#api-contract`.

The hardware integration checklist is included at the end of this document.

---

## Index

| Endpoint or topic | Direction | Protocol | Subsystem |
|---|---|---|---|
| `POST /internal/tickets/walk-in` | Hardware → Backend | HTTP | Ticket kiosk |
| `GET /internal/tickets/kiosk-config` | Hardware → Backend | HTTP | Ticket kiosk |
| `GET /internal/tickets/ticket-template` | Hardware → Backend | HTTP | Ticket kiosk |
| `POST /internal/attendance/check-rfid` | Hardware → Backend | HTTP | RFID |
| `POST /internal/access/door-access` | Hardware → Backend | HTTP | Zone door access |
| `POST /internal/tickets/call-next` | Hardware → Backend | HTTP | Queue counter display (7-segment) |
| `agency/{agency_id}/device/{device_id}/ticket-called` | Backend → Hardware | MQTT | Queue counter display (7-segment) |
| `agency/{agency_id}/device/{device_id}/sensor` | Hardware → Backend | MQTT | DHT11, MQ2 |
| `agency/{agency_id}/device/{device_id}/alert` | Backend → Hardware | MQTT | Buzzer / LED |
| `agency/{agency_id}/device/{device_id}/climate` | Backend → Hardware | MQTT | Climate actuator |
| `agency/{agency_id}/device/{device_id}/control` | Backend → Hardware | MQTT | Door lock/unlock, manual controls |
| `agency/{agency_id}/device/{device_id}/control-ack` | Hardware → Backend | MQTT | Reply to a control command |

The SG90 door actuator is handled by the single `access-sensors-1` ESP32.
The `/internal/access/door-access` endpoint returns the authorization decision;
the firmware actuates the servo locally.

---

## 1. Device identity and authentication

Every hardware device must first be registered by an authenticated backend
user through:

```text
POST /api/devices/agencies/{agency_id}
```

The backend returns a `device_key` once. The key must be stored securely in the
ESP32 and must not be committed to GitHub or shared in Discord.

The hardware `device_id` must be exactly the registered `mqtt_client_id`.
It is not the internal database UUID of the device.

Internal REST ingestion endpoints require:

```http
Content-Type: application/json
X-Device-Key: DEVICE_SECRET_KEY
```

MQTT authentication uses the broker credentials configured by the backend and
the broker. The REST `device_key` is not an MQTT password.

---

## 2. Hardware → Backend: REST ingestion

### POST /internal/tickets/walk-in

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
Content-Type: application/json
X-Device-Key: DEVICE_SECRET_KEY
```

**Request body:**

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "ticket-kiosk-01",
  "service_id": "SERVICE_UUID",
  "visitor": {
    "full_name": "Visiteur borne",
    "phone": null,
    "identity_reference": null
  },
  "timestamp": "2026-08-25T14:32:00Z"
}
```

**Response body:**

```json
{
  "ticket_id": "TICKET_UUID",
  "ticket_number": "20260825-VIR-001",
  "service_id": "SERVICE_UUID",
  "service_type": "Virement et consultation",
  "status": "WAITING"
}
```

**Success status:** `201 Created`
**Notes:**

- `service_id` is the preferred way to select the service.
- The selected service must be active and belong to `agency_id`.
- `service_type` may be used as a temporary legacy fallback instead of
  `service_id`; it must match the service code or name exactly, ignoring case.
- `visitor` is optional. If omitted, the backend creates a visitor named
  `Visiteur borne`.
- `timestamp` is optional. If omitted, the backend uses the current UTC time.
- The new ticket always starts in `WAITING` status.
- `401` means the `X-Device-Key` is missing or invalid.
- `404` means the device or service does not exist.
- `409` means the service is inactive.
- `422` means the service belongs to another agency or the payload is invalid.

### GET /internal/tickets/kiosk-config

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
X-Device-Key: DEVICE_SECRET_KEY
```

**Query parameters:**

```text
agency_id=AGENCY_UUID
device_id=ticket-kiosk-01
```

**Response body:**

```json
{
  "services": [
    {
      "service_id": "SERVICE_UUID_1",
      "code": "VIR",
      "name": "Virement et consultation",
      "counter_id": "COUNTER_UUID_1"
    },
    {
      "service_id": "SERVICE_UUID_2",
      "code": "OUV",
      "name": "Ouverture de compte",
      "counter_id": "COUNTER_UUID_2"
    }
  ],
  "messages": {
    "error_line1": "Erreur reseau",
    "error_line2": "Reessayez",
    "no_service_line1": "Aucun service",
    "no_service_line2": "disponible"
  }
}
```

**Success status:** `200 OK`
**Notes:**

- Every `is_active` service for `agency_id`, ordered by `code` -- same
  `services` table as `GET /api/agencies/{agency_id}/services`.
- The Uno cycles through all entries returned, not limited to 2.
- Send the selected entry's `service_id` (not `service_type`) to
  `POST /internal/tickets/walk-in`.
- `counter_id` is the first open counter assigned to the service, ordered by
  counter number. It is `null` when the service has no open assigned counter.
- Empty `services`: show "no service available", disable confirmation.
- `name` may exceed 16 columns; Uno truncates for display only.
- `messages`: 4 LCD lines, free text on `Device.kiosk_messages` (JSON),
  default to the values above when unset.
- `401` invalid/missing key. `404` unknown device.
- Poll periodically, not just at boot.

### GET /internal/tickets/ticket-template

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
X-Device-Key: DEVICE_SECRET_KEY
```

**Query parameters:**

```text
agency_id=AGENCY_UUID
device_id=ticket-kiosk-01
```

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
**Notes:**

- Returns the agency's saved template, or the following built-in default when
  no template has been configured:

  ```json
  [
    { "type": "text", "content": "Bienvenue chez nous" },
    { "type": "agency_name" },
    { "type": "ticket_number" },
    { "type": "service_name" },
    { "type": "date" }
  ]
  ```
- The firmware polls this endpoint at boot and every **60 seconds**. It keeps
  the last valid template if a later poll fails.
- Supported blocks are `text`, `agency_name`, `ticket_number`, `service_name`,
  `date`, `qrcode`, `image` and `spacing`. The firmware renders blocks in array
  order.
- A complete saved template can contain blocks such as:

  ```json
  [
    { "type": "text", "content": "Bienvenue chez nous" },
    { "type": "agency_name" },
    { "type": "ticket_number" },
    { "type": "service_name" },
    { "type": "date" },
    { "type": "qrcode", "content": "https://example.com/ticket" },
    { "type": "image", "data": "BASE64_PACKED_BITMAP", "rows": 120 },
    { "type": "spacing", "lines": 2 }
  ]
  ```
- `agency_name`, `ticket_number`, `service_name` and `date` have no content;
  their values are resolved when the ticket is printed.
- `text` prints its `content`; `qrcode` encodes its `content` as a QR code;
  `spacing` feeds the printer by `lines` lines.
- `image` is already processed for the printer: 384 dots wide, 1-bit Floyd-
  Steinberg dithered. `data` is base64 of packed rows, 48 bytes per row,
  most-significant bit first; bit `1` represents a black dot. `rows` is the
  number of rows.
- The template is a layout description, not a raw ESC/POS command stream. The
  ESP32 must translate each block to ESC/POS commands for the thermal printer.
- `401` means the key is missing or invalid and `404` means the device or
  agency does not exist.

### POST /internal/attendance/check-rfid

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
Content-Type: application/json
X-Device-Key: DEVICE_SECRET_KEY
```

**Request body:**

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "rfid-gate-01",
  "employee_rfid": "A1B2C3D4",
  "timestamp": "2026-08-25T09:15:00Z"
}
```

The hardware never sends `event` -- it only reads a raw UID and forwards it.
The backend decides `check_in` vs `check_out` itself: an employee with no
open attendance (no `check_out` recorded yet) checks in, an employee with one
checks out.

**Response when the event is accepted:**

```json
{
  "valid": true,
  "employee_name": "Hamza Benali",
  "event": "check_in",
  "message": null
}
```

**Response when the card or attendance event is invalid:**

```json
{
  "valid": false,
  "employee_name": null,
  "event": null,
  "message": "Carte RFID ou employe introuvable"
}
```

**Success status:** `200 OK`
**Notes:**

- An unknown card returns `200` with `valid: false`; this is a normal business
  response, not a network error.
- The employee must be active and belong to the agency in the request.
- The backend derives `check_in`/`check_out` from whether the employee
  already has an open attendance -- the hardware never sends or chooses it.
- A missing or invalid device key returns `401`.
- An unknown device returns `404`.

### POST /internal/access/door-access

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
Content-Type: application/json
X-Device-Key: DEVICE_SECRET_KEY
```

**Request body:**

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "access-sensors-1",
  "employee_rfid": "RFID-001",
  "zone_id": "ZONE_UUID",
  "timestamp": "2026-09-16T08:30:00Z"
}
```

**Response when access is authorized:**

```json
{
  "authorized": true,
  "employee_name": "Hamza Benali",
  "employee_role": "SECURITY",
  "zone_id": "ZONE_UUID",
  "message": "Acces autorise"
}
```

**Response when access is refused:**

```json
{
  "authorized": false,
  "employee_name": "Hamza Benali",
  "employee_role": "AGENT",
  "zone_id": "ZONE_UUID",
  "message": "Acces refuse pour cette zone"
}
```

**Success status:** `200 OK`
**Notes:**

- The ESP32 sends only the RFID, agency, device and zone identifiers. It does
  not decide the employee role or access policy.
- The backend returns `200` with `authorized: false` for an unknown card,
  inactive employee or a zone not assigned to the employee. These are normal
  business
  decisions and must not be retried indefinitely.
- The employee must be active and belong to the requested agency. The zone
  must also belong to that agency.
- Access is defined explicitly by `authorized_zone_ids` on the employee. The
  backend does not infer physical access from `Employee.role`; two employees
  with the same role may have different zones.
- `401` means the device key is missing or invalid. `404` means the device or
  zone does not exist. `422` means the zone belongs to another agency.
- **Badge + face rooms:** a room set to `rfid_face` in the dashboard also
  checks, once, that the face in front of its door camera is the badge
  holder's. The answer then takes up to about 5 seconds instead of being
  immediate: give this request an HTTP timeout of **10 seconds**, and show a
  "look at the camera" prompt on the reader while waiting. The face refusals
  come back as normal `authorized: false` answers with one of these messages:
  `Visage non detecte, regardez la camera`, `Visage non reconnu`,
  `Le visage ne correspond pas au badge`, `Camera de porte indisponible`,
  `Camera de porte non configuree`, `Verification du visage indisponible`,
  `Verification en cours, reessayez`. Do not retry automatically; a new badge
  tap starts a new check.
- The same ESP32 identified as `access-sensors-1` handles the RFID reader,
  DHT11, MQ2, SG90, fan and buzzer. The firmware opens the SG90 only when
  `authorized` is `true`.

---

## 3. Hardware ↔ Backend: Queue counter display (7-segment)

A TM1637 4-digit display on the same ESP32 as the ticket kiosk shows the
last-called ticket per service, formatted `A*C*` (e.g. `A5C2` -- the
trailing digit of each service's last-called `ticket_number`).

**Design principle:** the display never computes locally. It only ever
renders what a `ticket-called` MQTT message tells it, no matter what
triggered that message.

Two triggers publish the same `ticket-called` message, via the same "call
the next ticket" logic and the same `publish_ticket_called()`:

- **Frontend** (already implemented): `POST /api/tickets/{ticket_id}/call`,
  see `contracts/api.md`.
- **Button** (new, this section): `POST /internal/tickets/call-next` below.

So the display can never diverge between the two, and self-corrects on the
next message after any restart -- no boot-time fetch is needed.

### POST /internal/tickets/call-next

**Owner:** Hardware
**Type:** REST internal ingestion
**Headers:**

```http
Content-Type: application/json
X-Device-Key: DEVICE_SECRET_KEY
```

**Request body:**

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "queue-display-01",
  "service_id": "SERVICE_UUID",
  "counter_id": "COUNTER_UUID"
}
```

**Response body:**

```json
{
  "called": true,
  "ticket_id": "TICKET_UUID",
  "ticket_number": "20260827-SVC-A-006",
  "service_code": "SVC-A"
}
```

**Response body when the service's queue is empty:**

```json
{
  "called": false,
  "ticket_id": null,
  "ticket_number": null,
  "service_code": "SVC-A"
}
```

**Success status:** `200 OK`
**Notes:**

- `counter_id` comes from the matching entry's `counter_id` in
  `GET /internal/tickets/kiosk-config` (above), not hardcoded in the
  ESP32's secrets -- must be an open counter assigned to `service_id`,
  matching its `point_type`.
- Same logic as `POST /api/tickets/{ticket_id}/call`: picks the oldest
  `WAITING` ticket for `service_id`, one shared implementation, not a
  second divergent one.
- `called: false` (`200 OK`): queue empty, normal response, no auto-retry.
- Response used for success/failure only -- display updates via
  `ticket-called` below, never from this response.
- `401` invalid/missing key. `404` unknown device/service/counter.
  `409` counter closed. `422` counter/service/agency mismatch.

### MQTT agency/{agency_id}/device/{device_id}/ticket-called

**Owner:** Backend
**Type:** MQTT command
**Direction:** Backend → Hardware
**Response:** No response is expected.
**Status:** Already implemented (`c52dc51`) -- no new backend work.

The hardware must subscribe to:

```text
agency/{agency_id}/device/{device_id}/ticket-called
```

Published on every successful call (frontend or this device's own button)
to every `QUEUE_DISPLAY` device in the agency, including the one that
triggered it.

**Payload:**

```json
{
  "service_code": "SVC-A",
  "ticket_number": "20260827-SVC-A-005"
}
```

**Notes:**

- `service_code` identifies which digit (`A` or `C`) to update.
- The display extracts the trailing sequence from `ticket_number` and shows
  its last digit (`005` becomes `5`) for that service.
- A failed ticket call (from either pipeline) does not publish a message.
- Messages use normal MQTT QoS and are not retried by the backend.

### Queue counter display behavior

1. On button press: send `POST /internal/tickets/call-next` and block until
   a response arrives -- do not touch the display from this call, in either
   the success or the failure case.
2. Regardless of which pipeline triggered it, the display only updates on a
   `ticket-called` MQTT message: parse the trailing digit of `ticket_number`
   and set the matching service's digit to it.
3. On a failed button press (`called: false`, or `401`/`404`/`409`/`422`),
   leave the digit unchanged; log the outcome, do not retry beyond the
   connection-refused case noted above.
4. Never fetch or poll for the current ticket number on boot -- the display
   simply shows its last rendered state (or `A0C0` after a fresh flash)
   until the first `ticket-called` message arrives.

---

## 4. Hardware → Backend: MQTT sensor ingestion

### MQTT agency/{agency_id}/device/{device_id}/sensor

**Owner:** Hardware
**Type:** MQTT fire-and-forget
**Direction:** Hardware → Backend
**Response:** No MQTT response is expected.

The backend subscribes to:

```text
agency/+/device/+/sensor
```

The `device_id` in the topic must match a registered device's
`mqtt_client_id` in the same agency.

**DHT11 payload:**

```json
{
  "readings": [
    {
      "sensor_type": "temperature",
      "value": 24.5,
      "unit": "C"
    },
    {
      "sensor_type": "humidity",
      "value": 61.2,
      "unit": "%"
    }
  ],
  "timestamp": "2026-08-25T10:00:00Z"
}
```

**MQ2 payload (gas_co):**

```json
{
  "readings": [
    {
      "sensor_type": "gas_co",
      "value": 12.4,
      "unit": "ppm"
    }
  ],
  "timestamp": "2026-08-25T10:00:05Z"
}
```

Supported sensor type names are:

```text
temperature
humidity
gas_co
```

**Notes:**

- `readings` must contain at least one reading.
- `value` must be numeric.
- `timestamp` must be an ISO-8601 UTC date-time.
- The backend stores each reading in `sensor_readings`.
- An unregistered device message is rejected and logged by the backend.
- For `gas_co`, the hardware may send calibrated `ppm` directly (recommended), or a
  raw ADC value with unit `raw`, `adc`, `count` or `counts`.
- Raw MQ2 conversion is controlled by backend environment settings:
  `MQ2_RAW_TO_PPM_ENABLED`, `MQ2_RAW_BASELINE`, `MQ2_RAW_PPM_SCALE` and
  `MQ2_RAW_PPM_OFFSET`. The formula is
  `(raw - baseline) * scale + offset`, clamped to zero.
- Conversion is disabled by default. While disabled, raw values are stored as
  `raw` and are not compared with ppm thresholds, preventing false alerts.
- The hardware side must provide the calibrated baseline and scale from the real MQ2
  circuit before enabling the conversion in the deployment environment.

---

## 5. Backend → Hardware: MQTT alert command

### MQTT agency/{agency_id}/device/{device_id}/alert

**Owner:** Backend
**Type:** MQTT command
**Direction:** Backend → Hardware
**Response:** No response is expected.

The hardware must subscribe to:

```text
agency/{agency_id}/device/{device_id}/alert
```

**Active alert:**

```json
{
  "alert_type": "gas_co",
  "active": true,
  "severity": "CRITICAL"
}
```

**Resolved alert:**

```json
{
  "alert_type": "gas_co",
  "active": false,
  "severity": "LOW"
}
```

Allowed severity values:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

**Threshold behavior:**

- `warning_max` exceeded → alert severity `HIGH`.
- `critical_max` exceeded → alert severity `CRITICAL`.
- Value returns below the configured limits → `active: false` and severity
  `LOW`.

The ESP32 must activate the buzzer/LED when `active` is `true` and deactivate
it when `active` is `false`.

---

## 6. Backend → Hardware: MQTT climate command

### MQTT agency/{agency_id}/device/{device_id}/climate

**Owner:** Backend
**Type:** MQTT command
**Direction:** Backend → Hardware
**Response:** No response is expected.

The hardware must subscribe to:

```text
agency/{agency_id}/device/{device_id}/climate
```

**Activate climate actuator:**

```json
{
  "active": true
}
```

**Deactivate climate actuator:**

```json
{
  "active": false
}
```

The climate state follows the configured `warning_max` threshold for the
`temperature` sensor. The backend republishes the current state when it
receives a temperature reading so the actuator can recover after a restart.

---

## 6b. Backend → Hardware: MQTT control command (doors and manual controls)

### MQTT agency/{agency_id}/device/{device_id}/control

**Owner:** Backend
**Type:** MQTT command
**Direction:** Backend → Hardware

The hardware must subscribe to:

```text
agency/{agency_id}/device/{device_id}/control
```

**Payload:**

```json
{
  "correlation_id": "a1b2c3d4e5f6...",
  "action": "unlock",
  "target": null
}
```

Sent in two cases:

- **Automatically**, to every door device of the agency (device type `DOOR`
  or `ACCESS_SENSORS`, so `access-sensors-1` receives them): `unlock` when a
  CRITICAL gas/CO or fire alert opens (people must be able to get out), and
  `lock` on a confirmed weapon detection when the agency has weapon lockdown
  turned on. No reply is awaited for these.
- **Manually**, from the dashboard's Manual controls screen: one button per
  command listed for the device's type in `contracts/device-commands.json`.
  The dashboard only offers, and the backend only sends, those actions. The
  dashboard waits up to 10 seconds for the reply below.

**`contracts/device-commands.json` is the list of commands each device type
must implement.** Adding a command means adding it there, here, and in the
firmware, in the same change (a backend test fails if this section does not
name every action of that file). Today:

- `ACCESS_SENSORS` and `DOOR`: `unlock` opens the SG90 and keeps it open
  until told otherwise; `lock` closes it and keeps refusing to open it on a
  badge until `unlock`.

An `action` the firmware does not implement is answered with
`status: "unknown_action"`, never ignored silently: the dashboard then tells
the operator the firmware and the contract disagree.

### MQTT agency/{agency_id}/device/{device_id}/control-ack

**Owner:** Hardware
**Type:** MQTT reply
**Direction:** Hardware → Backend

Reply to every control command, echoing its `correlation_id`:

```json
{
  "correlation_id": "a1b2c3d4e5f6...",
  "status": "ok",
  "detail": "door unlocked"
}
```

`status` is `ok` when the action was carried out, `unknown_action` when the
firmware does not implement that action, anything else (e.g. `error`) when it
was not carried out; `detail` is free text shown to the operator.

---

## 7. Hardware integration checklist

### Before connecting the ESP32

1. Register each device in the backend using
   `POST /api/devices/agencies/{agency_id}`.
2. Save the returned `device_key` in the ESP32 secure configuration.
3. Use the returned `mqtt_client_id` as `device_id` in all requests and MQTT
   topics.
4. Do not use the device database UUID as the MQTT `device_id`.
5. Configure the MQTT broker host, port, username and password.
6. Configure the agency UUID and service UUID in the device configuration.

### Ticket kiosk

See `POST /internal/tickets/walk-in`, `GET /internal/tickets/kiosk-config`
and `GET /internal/tickets/ticket-template` above for full request/response
shapes and behavior.

1. Send `X-Device-Key` on every request; treat `401`/`404`/`422` as
   request/configuration errors and log them.
2. `walk-in`: prefer `service_id` over `service_type`; read `ticket_number`
   from the `201` response and display it.
3. `kiosk-config`: poll periodically, not just at boot; use `counter_id`
   per service for the queue-display buttons, not a hardcoded value.
4. `ticket-template`: poll rarely (boot + ~10-15 min), never per ticket.

### RFID reader (attendance)

See `POST /internal/attendance/check-rfid` above.

1. Send the RFID UID exactly as scanned, no `event` field -- the backend
   decides `check_in`/`check_out`.
2. Treat `200` with `valid: false` as a normal rejected-card response, not
   an error; log the returned `message` without retrying indefinitely.

### Queue counter display (7-segment)

1. Register the device with `device_type: "QUEUE_DISPLAY"` exactly (the
   backend's `publish_ticket_called()` matches on this, case-insensitively)
   -- a device registered with any other `device_type` will never receive
   `ticket-called` messages.
2. Configure a fixed `counter_id` per physical button/service in the ESP32's
   own secrets -- there is no endpoint to discover it dynamically.
3. On a button press, send `POST /internal/tickets/call-next` and wait for
   the response, only to know success/failure -- never read `ticket_number`
   from it to update the display.
4. On failure (`called: false`, `401`/`404`/`409`/`422`/timeout/network
   drop), leave the digit unchanged and log the outcome; only auto-retry a
   connection-refused failure, same rule as `walk-in`/`check-rfid`.
5. Subscribe to `agency/{agency_id}/device/{device_id}/ticket-called` --
   this is the *only* place the display digit is ever set, for both this
   device's own button presses and every frontend-triggered call.
6. On each message, extract the trailing digit of `ticket_number` and set
   the matching service's digit to it.
7. Do not fetch or poll for the current ticket number on boot -- both
   triggers always end in a `ticket-called` push when they succeed.

### Zone door reader and shared ESP32

1. Register the shared ESP32 as a backend device with `mqtt_client_id` exactly
   equal to `access-sensors-1`, and store its `device_key`
   securely on the ESP32.
2. Send `POST /internal/access/door-access` with the reader's registered
   `device_id`, the agency UUID, the zone UUID and the scanned RFID.
3. Add `X-Device-Key` and do not send the device database UUID as `device_id`.
4. Unlock the SG90 only when the response contains `authorized: true`.
5. Treat `authorized: false` as a normal access refusal: keep the door locked,
   show/log the returned message and do not retry indefinitely.
6. `401`, `404` and `422` indicate device or configuration errors and should
   be logged for correction.
7. Subscribe to `agency/{agency_id}/device/access-sensors-1/control` and
   implement `lock` / `unlock` (section 6b): the backend sends `unlock` on a
   CRITICAL gas or fire alert and `lock` on a weapon lockdown. Reply on
   `.../control-ack` with the same `correlation_id`.
8. The same ESP32 also publishes the DHT11 and MQ2 readings and controls the
   fan and buzzer. Keep these functions independent in the firmware loop.

### DHT11 and MQ2

1. Publish DHT11 readings on
   `agency/{agency_id}/device/{device_id}/sensor`.
2. Publish MQ2 readings on the same topic using `sensor_type: gas_co`.
3. Use exactly `temperature`, `humidity` and `gas_co` as sensor type names.
4. Send UTC timestamps in ISO-8601 format.
5. Subscribe to both `/alert` and `/climate` topics.
6. Parse every command as JSON and apply the `active` state immediately.

### Threshold calibration

Configure thresholds through the backend before testing alerts:

```text
PUT /api/devices/{device_id}/thresholds/temperature
PUT /api/devices/{device_id}/thresholds/humidity
PUT /api/devices/{device_id}/thresholds/gas_co
```

Example gas (MQ2, `gas_co`) threshold:

```json
{
  "unit": "ppm",
  "warning_max": 10,
  "critical_max": 20,
  "is_active": true
}
```

The values above are examples only. They must be calibrated according to the
real sensors and the intended safety limits.

### Security and reliability requirements

- Never commit `device_key`, MQTT passwords or Wi-Fi passwords to GitHub.
- Use HTTPS for REST ingestion outside the local network.
- Use authenticated MQTT and TLS in production.
- Add a timeout and bounded retry policy to HTTP requests.
- Do not create duplicate tickets when retrying after an unknown network
  failure; first verify whether the backend already returned a ticket.
- Log the HTTP status and MQTT topic for each failed integration test.
