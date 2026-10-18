# SmartAgency developer guide

How the system fits together, how to run it locally, how to test it, and how to
extend it without breaking the contracts other parts depend on.

For what the screens do from a user's point of view, see
[user-guide.md](user-guide.md). How this version differs from `master` is in
[version-comparison.md](version-comparison.md). Rules for branches, pull requests and reviews
are in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1. Architecture

```
  ESP32 / Arduino devices                Cameras (RTSP)
  (gate reader, door, sensors,                 |
   kiosk, queue display)                       v
     |  HTTP /internal/* (X-Device-Key)   AI service (FastAPI, ai/features)
     |  MQTT agency/{a}/device/{d}/...    weapon, fire, emotion, wanted, face,
     v                                    zoning, calibration, person tracking
  +-----------------------------------+        ^   |  REST + WebSocket streams
  |  Backend (FastAPI, backend/app)   |--------+   |
  |  REST /api/*, WS /ws/*            |<-----------+
  |  background workers               |
  |  PostgreSQL, MQTT broker, Redis   |
  +-----------------------------------+
                 ^  REST + WebSocket (JWT)
                 |
  Frontend dashboard (React, frontend/)
```

Rules that hold everywhere:

- **The browser never talks to the AI service or to devices.** Every AI call,
  stream and device command goes through the backend, which adds login, roles,
  branch scoping and the audit log.
- **Devices never use user logins.** They authenticate each HTTP request with
  their own device key (`X-Device-Key`) and talk MQTT for streams and commands
  (the device key is not an MQTT password; the topic's device id must match a
  registered device of that agency).
- **The contracts are the source of truth** (`contracts/`): `api.md` for the
  dashboard API, `ingestion.md` for devices, `ai-service.md` for the AI service,
  `device-commands.json` for manual device commands. Tests fail when the code
  and the contracts disagree (section 9).
- **One machine, no cloud.** The deployed product runs on a single local
  machine.

---

## 2. Repository layout

| Folder | What is in it |
|---|---|
| `backend/` | FastAPI app (`app/`), Alembic migrations, tests, `seed_dev.py` |
| `frontend/` | React 19 + TypeScript + Vite dashboard, Vitest tests, mock layer |
| `ai/features/` | The computer-vision service (one FastAPI app, many features) |
| `contracts/` | `api.md`, `ingestion.md`, `ai-service.md`, `device-commands.json` |
| `hardware/` | Firmware and hardware glue |
| `integration/` | Glue translating raw hardware/AI events into contract shapes |

### Backend (`backend/app/`)

| Folder | Role |
|---|---|
| `api/` | One router per area. `internal.py` holds the device-facing routes |
| `services/` | Business logic and background workers (below) |
| `ai_alerts/` | AI stream consumers (weapon, fire, wanted, emotion), thresholds, incidents, the AI forwarding helper `ai_service.py` |
| `mqtt/` | MQTT consumers (attendance, sensors), manual control, topic names |
| `websocket/` | `/ws/*` endpoints: attendance, AI stream proxies, alert state frames |
| `models/entities.py` | All SQLAlchemy models |
| `schemas/` | Pydantic request/response models |
| `core/` | Settings (`config.py`), security (JWT, roles), device keys |
| `database/` | Session, Alembic migrations |

### Background workers (started in `main.py`)

| Worker | What it does |
|---|---|
| `attendance_consumer`, `sensor_consumer` | MQTT: badge events, sensor readings, threshold alerts, climate actuation |
| `weapon/fire/wanted_alert_consumer` | AI alert streams to stored alerts (incidents, stickiness, door lockdown/unlock) |
| `emotion_consumer` | AI emotion stream to satisfaction samples |
| `manual_control_service` | Sends `control` commands and waits for the device's ack |
| `people_track_tracker` | Keeps the live tracked positions; drops them when the stream goes quiet |
| `zone_watcher` | Restricted zones: intrusion alerts, track hand-off, "zones not watched" |
| `health_monitor` | AI/MQTT down alerts, device uptime samples, end-of-day ticket closing |

### Frontend (`frontend/src/`)

| Folder | Role |
|---|---|
| `screens/` | One file per screen, plus panels and pure helpers next to them |
| `api/` | `client.ts` (fetch + auth + mock switch), `endpoints/*.ts` (one function per route), `types.ts` |
| `auth/` | Session, `access.ts` (which role reaches which screen), `screens.ts` (navigation) |
| `agency/` | The branch scope an admin is "inside" |
| `components/` | Shell, UI kit (`components/ui`), shared hooks like `openAlerts.ts` |
| `mocks/` | Fixtures, in-memory stores and role rules for mock mode |

---

## 3. Running it locally

### 3.1 Prerequisites
- Python 3.10, Node 20+, Docker (for PostgreSQL, Redis and the MQTT broker).
- For the AI service: its own `ai/features/requirements.txt` (models download on
  first run; a GPU helps but is not required for a demo).

### 3.2 Infrastructure

```bash
docker run -d --name sa-postgres -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=agence_iot -p 5433:5432 postgres:16-alpine
docker run -d --name sa-redis    -p 6380:6379 redis:7-alpine
docker run -d --name sa-mqtt     -p 1884:1883 eclipse-mosquitto:2
```

The ports are shifted (5433, 6380, 1884) to avoid clashing with local installs;
use the defaults if you prefer and change `.env` to match.

### 3.3 Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env              # then edit, see below
alembic upgrade head
python seed_dev.py                # dev branch, 5 roles, accounts, devices, services
uvicorn app.main:app --port 8000
```

In `.env`, at least:

```env
DATABASE_URL=postgresql+psycopg2://postgres:devpass@localhost:5433/agence_iot
MQTT_PORT=1884
REDIS_URL=redis://localhost:6380/0
AI_SERVICE_URL=http://127.0.0.1:8001
SECRET_KEY=<python -c "import secrets; print(secrets.token_urlsafe(48))">
```

Seeded accounts: `admin@smartagency.local`, `manager@`, `agent@`, `security@`,
`technician@smartagency.local`, password `Admin12345` (override with
`SEED_PASSWORD`). API docs: http://127.0.0.1:8000/docs.

Avoid `--reload` if you see duplicate processes fighting over the port on
Windows; restart the process after edits instead.

### 3.4 AI service

```bash
cd ai
pip install -r features/requirements.txt
uvicorn features.main:app --port 8001
```

It has **no authentication**: keep it bound to localhost or a closed network.
See `ai/features/README.md` for its configuration (`GET /config` shows what is
in effect, `PATCH /config` changes it live) and the GPU variant.

### 3.5 Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev                       # http://localhost:5173
```

Two modes, chosen in `.env.local`:

- **Mock mode** (`VITE_USE_MOCKS=true`, the default): no backend needed. Every
  endpoint is answered from `src/mocks/` and any email/password signs you in.
  `VITE_MOCK_SCENARIO=normal|empty|large|error` picks the fixture variant.
- **Real mode**: `VITE_USE_MOCKS=false` and `VITE_API_BASE_URL=http://localhost:5173`
  (the dev server itself). Vite proxies `/api` and `/ws` to the backend
  (`VITE_DEV_BACKEND`, default `http://127.0.0.1:8000`), which keeps every call
  same-origin; the backend has no CORS middleware. Set `VITE_WS_AUTH_MODE=query`
  to enable the live sockets.

The access token is held in memory only: reloading the page signs you out.

### 3.6 Talking to the system like a device

Register a device from the dashboard (**IoT devices**) to get its key, then:

```bash
# a badge at the gate
curl -X POST http://127.0.0.1:8000/internal/attendance/check-rfid \
  -H "X-Device-Key: <key>" -H "Content-Type: application/json" \
  -d '{"agency_id":"<agency>","device_id":"rfid-gate-01","employee_rfid":"RFID-123","timestamp":"2026-10-19T08:00:00Z"}'

# a sensor reading over MQTT
mosquitto_pub -p 1884 -t "agency/<agency>/device/<device>/sensor" \
  -m '{"readings":[{"sensor_type":"temperature","value":24.5,"unit":"C"}],"timestamp":"2026-10-19T08:00:00Z"}'
```

Exact payloads, every topic and the error answers are in `contracts/ingestion.md`.
What the firmware must change for this version is in
[hardware-changes.md](hardware-changes.md).

---

## 4. Configuration reference (backend `.env`)

| Setting | Default | Purpose |
|---|---|---|
| `APP_ENV` | development | `production` refuses to start with the default `SECRET_KEY` |
| `SECRET_KEY` | (unsafe default) | Signs login tokens |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | 30 | Access token lifetime |
| `DATABASE_URL`, `REDIS_URL` | local | Storage |
| `MQTT_HOST/PORT/USERNAME/PASSWORD` | localhost:1883 | Broker |
| `AI_SERVICE_URL` | http://127.0.0.1:8001 | The AI service |
| `AI_ALERTS_ENABLED` | true | Turns off every AI consumer and the zone watch (tests, no AI) |
| `AI_RECONNECT_DELAY_SECONDS`, `AI_SOURCE_SYNC_INTERVAL_SECONDS` | 5, 15 | AI stream reconnects and camera source sync |
| `AI_WS_MAX_CONNECTIONS(_PER_USER)` | 50, 5 | Limits on proxied AI sockets |
| `MANUAL_CONTROL_ACK_TIMEOUT_SECONDS` | 10 | How long a manual command waits for the device |
| `DOOR_FACE_TIMEOUT_SECONDS` | 4 | Badge + face: how long the door camera looks for a face |
| `DEVICE_COMMANDS_FILE` | `contracts/device-commands.json` | Manual commands per device type |
| `PEOPLE_TRACKS_STALE_SECONDS` | 5 | Tracked positions older than this are dropped |
| `ZONE_INTRUSION_GRACE_SECONDS` | 5 | Time someone may stand in a restricted zone before the alert |
| `ZONE_HANDOFF_SECONDS`, `ZONE_HANDOFF_DISTANCE` | 2, 100 | When a new track inherits a lost employee (seconds, floor cm) |
| `NOTIFICATIONS_ENABLED`, `VAPID_*`, `SMTP_*` | | Critical-alert push (Web Push) and email fallback |
| `HEALTH_MONITOR_ENABLED`, `HEALTH_CHECK_INTERVAL_SECONDS`, `HEALTH_DOWN_GRACE_SECONDS` | true, 10, 45 | AI/MQTT down alerts (the grace also applies to "zones not watched") |
| `DEVICE_SAMPLE_INTERVAL_SECONDS`, `DEVICE_MISSED_HEARTBEATS`, `DEVICE_SAMPLE_RETENTION_DAYS` | 300, 3, 90 | Device uptime history |
| `MQ2_RAW_*` | disabled | Raw gas sensor calibration |

---

## 5. How the main features work

### Tickets
The kiosk polls `GET /internal/tickets/kiosk-config` for its services and
posts `POST /internal/tickets/walk-in` on a button press. In the background,
the backend links the ticket to the person standing in the branch's **kiosk
zone** and captures their face embedding (returning-visitor recognition, no
identity stored). Agents call, start, skip and complete through
`/api/tickets/*`; each call publishes `ticket-called` over MQTT for the counter
display. `health_monitor` closes leftover tickets as `NO_SHOW` at the branch's
closing time.

### Attendance and doors
`POST /internal/attendance/check-rfid` records a badge at the gate.
`POST /internal/access/door-access` answers a door reader: the employee must
be active and allowed in that badge room; a `rfid_face` room also asks the AI
service once (`/face/scan` on the room's door camera) whether the face is the
badge holder's (`services/door_face.py`, enrolled under `emp-<employee id>`).
It fails closed. Refusals go to the access-failure log (`services/access_log.py`).
A badge tap at a reader with a **badge zone** links the employee to the tracked
person standing in that zone (`link_employee_tracking`).

### Sensors and building automation
`sensor_consumer` stores readings, opens/updates/resolves threshold alerts,
publishes `climate` (fan) and `alert` (buzzer) commands, and on a CRITICAL
gas/CO alert unlocks every door (`services/door_control_service.py`).

### Camera alerts
Each consumer registers the cameras whose `ai_features` include it, reads the
AI stream and turns detections into stored alerts. Weapon and wanted alerts are
**incidents** (`ai_alerts/incidents.py`): one per branch per subject, closed only
by a person. Fire opens per camera and unlocks the doors. A confirmed weapon
locks them when the branch has weapon lockdown on.

### People tracking and restricted zones
`people_track_tracker` holds the live positions from the AI's tracker stream and
forgets them when the stream is silent for `PEOPLE_TRACKS_STALE_SECONDS`.
`zone_watcher` ticks every second: it hands a lost employee's link to a new
track appearing close by, and raises one sticky `intrusion` alert per person not
allowed in a `staff`/`nobody` zone (`ZoneRule`). Only world zones can be
watched. Recalibrating or aligning re-saves every world zone from its original
pixels (`services/zone_reproject.py`).

### Notifications
Every newly opened CRITICAL alert goes to `notify_critical_alerts`: Web Push to
each subscribed browser, email to users without one.

### Manual controls
`GET /api/controls/commands` serves `contracts/device-commands.json`; the backend
refuses any action not listed for the device's type, then publishes `control`
with a correlation id and waits for `control-ack`. A device answering
`unknown_action` is reported as firmware/contract drift.

---

## 6. Security model

- **Login**: JWT access + refresh tokens. The role is re-read from the database
  on every request, so a disabled or demoted account loses access immediately.
  Login is throttled (5 failures per email, 30 per address, per 10 minutes).
- **Roles**: every route declares its roles with `require_roles(...)`, and they
  must match the `**Roles:**` line of its `api.md` entry (tested).
- **Branch scoping**: a non-admin only reaches their own agency. Routes with an
  `agency_id` check it; AI configuration is scoped through the camera's branch
  (`services/branch_scope.py`); watchlist and face gallery names record their
  owning branch (`GalleryEntry`).
- **Devices**: each device has its own key, stored hashed; rotating it is
  audit-logged.
- **Audit log** (`AuditLog`): offboarding, device key rotation, manual commands,
  manual track links, watchlist and face changes, and more.
- The AI service has no authentication of its own: never expose its port.

---

## 7. Data model in brief

The central tables: `agencies`, `users` (logins, role, branch, counter),
`employees` (badge, status, tracking link), `zones` (badge rooms, access mode,
door camera), `devices` (key hash, badge zone), `cameras` (stream, AI features),
`services`, `counters`, `visitors`, `tickets`, `alerts`, `sensor_readings`,
`emotion_samples`, `zone_rules` (restricted camera zones), `gallery_entries`,
`audit_logs`. Camera zones themselves (polygons) live in the AI service, keyed by
name. See `models/entities.py`.

Migrations: `backend/app/database/migrations/versions/`. Create one with
`alembic revision -m "what it does"`, write `upgrade` and `downgrade` by hand,
and keep a single head (`alembic heads`).

---

## 8. Testing

```bash
# backend (from backend/)
python -m pytest -q

# frontend (from frontend/)
npm test             # vitest
npx tsc -b           # types
npm run lint         # oxlint + prettier --check
npm run build
```

Backend tests run on in-memory SQLite. Code that opens its own sessions
(background workers) is pointed at the same database through `SESSION_MODULES`
in `tests/conftest.py`: add your module there when you write a new worker.
Route tests override `get_db` and `get_current_user` (see `tests/test_alerts_api.py`).

Frontend tests render screens either against the mock layer (`import '@/mocks'`)
or with `vi.mock` on the endpoint module.

---

## 9. Guard-rail tests (what fails when you forget something)

| Test | Fails when |
|---|---|
| `test_access_control.py` | A route answers without a login, lets in a role it should not, crosses branches, is missing from `api.md`, or its roles differ from `api.md` |
| `mocks/coverage.test.ts` | A frontend endpoint has no fixture or writer in mock mode |
| `test_manual_commands.py` | `device-commands.json` and `ingestion.md` disagree on the commands |
| `auth/access.test.ts`, `AppShell.test.tsx` | A screen's role rules and the navigation drift apart |

---

## 10. How to

### Add an API route
1. Write the route in `backend/app/api/<area>.py` with `require_roles(...)` and,
   if it reads branch data, a branch check.
2. Document it in `contracts/api.md` (method, path, `**Roles:**`, bodies, notes).
3. Add the frontend function in `frontend/src/api/endpoints/<area>.ts` with a
   `key: 'METHOD /api/path/{id}'`.
4. Add a fixture (`registerMock`) or writer (`registerMockWriter`) in
   `frontend/src/mocks/fixtures/`, and its roles in `mocks/roles.ts` if the
   prefix rules there are wrong for it.
5. Run both test suites: the guard rails in section 9 tell you what is missing.

### Add a screen
1. `frontend/src/screens/<Name>.tsx`, lazy route in `App.tsx`.
2. Navigation entry in `auth/screens.ts`, role rule in `auth/access.ts`.
3. A test next to it.

### Add a manual device command
1. Add `{ "action": "...", "label": "..." }` under the device type in
   `contracts/device-commands.json`.
2. Describe it in `contracts/ingestion.md` section 6b (the test requires it).
3. The firmware implements it and answers `unknown_action` for anything else.
4. Restart the backend: the button appears on its own.

### Add a background worker
Follow `services/zone_watch.py`: a class with `start()`/`stop()` and a daemon
thread, started and stopped in `main.py`, gated by its setting, its module added
to `SESSION_MODULES` for tests, and a `tick()` that tests can call with injected
inputs.

### Add an alert type
Create `Alert` rows with a new `alert_type`, call `notify_critical_alerts` for
CRITICAL ones, broadcast `alert_state_payload` frames, add its label in
`frontend/src/components/openAlerts.ts`, and list it in `api.md`'s alerts notes.

---

## 11. Known limitations

- **Calibration scale**: the AI service assumes the clicked calibration
  rectangle's short side is 1 m. Distances are only real when that is true.
- **One AI service per site**: calibration, the floor frame and the galleries
  are shared by every branch on it; the backend scopes who may change what, but
  the data itself is site-wide.
- **Live alert frames** exist only for the camera feeds; other alert types reach
  the dashboard through a 5-second refresh (push notifications are immediate).
- **Pixel zones** cannot be used for tracking features (kiosk link, badge zones,
  restricted zones); draw world zones. Workstations and occupancy work with
  either.
