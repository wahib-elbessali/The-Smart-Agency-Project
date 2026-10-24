# Mocking guide

How to work on SmartAgency without the real hardware, the real cameras, or
both. There are two ways, and they answer different questions:

| | Classic mocking | Live mocking |
|---|---|---|
| What is fake | Everything outside the piece you are building | Only the physical world: people, cameras, devices |
| What is real | The code under test | The backend, its database, the AI service's configuration, the dashboard |
| Setup | None | Docker, the AI service, one setup script |
| Best for | Building a screen or a route, unit and screen tests, CI | Playing a whole working day, checking features end to end, demos, finding the bugs that only show when everything runs together |
| Speed | Instant | Real time, or faster with the fake clock |

Use classic mocking while you build; use live mocking to prove it works.

The scripts for live mocking are in `tools/sim/`. The whole guide can be
followed alone or with an AI assistant driving the simulation for you (part 3).

---

## Part 1. Classic mocking

### 1.1 The dashboard without a backend (frontend mock mode)

In `frontend/.env.local`:

```env
VITE_USE_MOCKS=true
VITE_MOCK_SCENARIO=normal      # normal | empty | large | error
```

Then `npm run dev`. Any email and password sign you in (as a manager by
default; the login screen lists the test accounts for the other roles).

**How it works.** Every API function in `src/api/endpoints/*.ts` calls
`fetchJson` with a `key` such as `'GET /api/agencies/{id}/counters'`. With mocks
on, `src/api/client.ts` never sends the request: it hands the key to
`src/mocks/registry.ts`, which answers from:

| Piece | Where | What it does |
|---|---|---|
| Read fixtures | `src/mocks/fixtures/*.ts`, `registerMock(key, {normal, empty, large, error?})` | One function per scenario; gets the real path (ids, query string) |
| Write handlers | same files, `registerMockWriter(key, (body, path) => ...)` | Change an in-memory store so the next read shows the change |
| Stores | `src/mocks/*Store.ts` | Mutable mock data (employees, devices, zones, alerts...) |
| Role rules | `src/mocks/roles.ts` | The same 403s the backend gives each role |
| Live streams | `src/mocks/aiStreams.ts`, `attendanceStream.ts` | Scripted WebSocket frames (a weapon appears, a badge scan arrives) |

**Adding a mock for a new endpoint:**

```ts
// src/mocks/fixtures/myArea.ts
import { registerMock, registerMockWriter } from '../registry'

registerMock<Thing[]>('GET /api/agencies/{id}/things', {
  normal: (path) => store.list(path.split('/')[3]),
  empty: () => [],
  large: (path) => store.list(path.split('/')[3]),
})

registerMockWriter('POST /api/agencies/{id}/things', (body, path) =>
  store.create(path.split('/')[3], body as ThingCreate),
)
```

Then import the file in `src/mocks/index.ts`, and add the route's roles to
`src/mocks/roles.ts` if the prefix rules there do not already give the right
ones. `src/mocks/coverage.test.ts` fails as long as any endpoint the app calls
has no fixture or writer, so you cannot forget.

**In screen tests**, either use the mock layer (`import '@/mocks'` and render
the screen) or replace one endpoint module with `vi.mock(...)`; see
`src/screens/Devices.test.tsx` and `src/screens/ManualControls.test.tsx`.

### 1.2 The backend without a database server, AI service or broker (tests)

`cd backend && python -m pytest -q`. What `tests/conftest.py` gives you:

| Fixture / helper | What it is |
|---|---|
| `db`, `factory` | A fresh in-memory SQLite database per test |
| `roles`, `agency` | The five roles, one branch |
| `make_user(db, roles, RoleName.X, agency_id, email)` | A user of any role |
| `SESSION_MODULES` | Modules whose background code opens its own sessions; they are pointed at the test database. Add yours when you write a worker |

**Calling a route as a given user:**

```python
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app

app.dependency_overrides[get_db] = lambda: db
app.dependency_overrides[get_current_user] = lambda: manager
try:
    response = TestClient(app).get(f"/api/agencies/{agency.id}/counters")
finally:
    app.dependency_overrides.clear()
```

**Faking the AI service:** every call to it goes through a module's `forward`;
replace it with one that answers what you need:

```python
def fake(method, path, **kw):
    if path == "/zoning/zones":
        return httpx.Response(200, json={"Back office": {"mode": "world", "polygon_m": [[0, 0], [2, 0], [2, 2]]}})
    return httpx.Response(200, json={})

monkeypatch.setattr(zones_api, "forward", fake)
```

**Faking AI streams:** consumers have a public `process_message(...)`; feed it
the frames the AI would send (`tests/test_incidents.py`).

**Faking time and live data in workers:** workers expose a `tick(...)` that
takes the time and inputs as arguments (`ZoneWatcher.tick(now=..., tracks=...,
zones=..., live=...)`, `tests/test_zone_watch.py`). Test sequences by calling it
with increasing times.

**Faking a device's MQTT reply:** give the service a fake client whose
`publish` answers straight away (`tests/test_manual_commands.py`).

### 1.3 Poking a running backend like a device

With the backend running (any database), register a device in the dashboard to
get its key, then send what the device would send:

```bash
# kiosk button: a ticket
curl -X POST http://127.0.0.1:8000/internal/tickets/walk-in -H "X-Device-Key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"agency_id":"<agency>","device_id":"ticket-kiosk-01","service_id":"<service>","timestamp":"2026-10-19T09:00:00Z"}'

# a badge at a badge room door
curl -X POST http://127.0.0.1:8000/internal/access/door-access -H "X-Device-Key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"agency_id":"<agency>","device_id":"access-sensors-1","employee_rfid":"RFID-DEV-MANAGER","zone_id":"<room>","timestamp":"2026-10-19T09:00:00Z"}'

# a sensor reading
mosquitto_pub -p 1883 -t "agency/<agency>/device/access-sensors-1/sensor" \
  -m '{"readings":[{"sensor_type":"temperature","value":31}],"timestamp":"2026-10-19T09:00:00Z"}'

# watch what the backend tells devices (displays, buzzer, fan, doors)
mosquitto_sub -p 1883 -t "agency/<agency>/device/#" -v
```

Every payload is defined in `contracts/ingestion.md`. This is enough for one
device at a time; for a whole branch, use live mocking.

---

## Part 2. Live mocking: a simulated branch

### 2.1 What it is

```
 browser ──> dashboard (vite, sim config) ──> backend (fake clock) ──> world.py ──> real AI service
                                                   ^      ^              |  (config, zones, calibration,
                                       HTTP + MQTT |      |  AI streams  |   galleries are proxied here)
                                                   └──────┴── simulated devices + people + cameras
```

`tools/sim/world.py` stands where the backend expects the AI service. It
simulates a 12 m x 8 m branch floor with people walking around it, seen by four
virtual cameras (cam1 entrance wall, cam2 side wall, cam3 kiosk face camera,
cam4 door camera), and the four devices (kiosk, gate reader, queue display,
door/sensor board). Everything that needs video (live detections, camera
frames, person tracking, face scans) comes from the simulation; everything that
is configuration (cameras, calibration, zones, workstations, faces, watchlist,
detector settings) goes to the real AI service, so what you set up in the
dashboard is real.

| Real | Simulated |
|---|---|
| Backend, database, dashboard, every rule and alert | People and where they walk |
| AI service configuration and storage | Camera pictures and what the detectors see |
| MQTT broker and every message on it | The devices' firmware (they answer like the contract says) |
| Calibration maths, zone counting, tracking links | Faces (a person's `face` is a name in the gallery) |

### 2.2 One-time setup

Prerequisites: the backend set up as in the developer guide (database migrated
and seeded), Docker containers running, the AI service's dependencies installed.

```bash
pip install -r tools/sim/requirements.txt
```

**1. Start the real AI service** on its own port (here 8001):

```bash
cd ai && uvicorn features.main:app --port 8001
```

**2. Start the backend pointing at the world** (here 8123), on the fake clock
(or the normal `uvicorn app.main:app` if you do not need to move time):

```bash
# backend/.env: AI_SERVICE_URL=http://127.0.0.1:8123
python tools/sim/run_fake_clock.py 2026-10-19T07:45:00Z
```

**3. Register the simulated devices** (writes `tools/sim/sim_config.json`,
which holds device keys and is git-ignored):

```bash
python tools/sim/setup_sim.py devices --email admin@smartagency-dev.com --password Admin12345 --mqtt-port 1883
```

Options: `--agency` (part of a branch name), `--backend`, `--world`,
`--real-ai`, `--mqtt-host`, `--mqtt-port`. Existing devices with the same ids
get a new key (development data only).

**4. Start the world:**

```bash
cd tools/sim && uvicorn world:app --port 8123
```

**5. Build the simulated floor** (cameras, calibration, alignment, tracking,
zones, kiosk zone, gate badge zone, workstations):

```bash
python tools/sim/setup_sim.py vision --email admin@smartagency-dev.com --password Admin12345
```

**6. Start the dashboard with the browser on the fake clock:**

```bash
cd frontend && npx vite --config vite.sim.config.ts
```

Open http://localhost:5173 and sign in. The **Live map** should show tracking
running; the setup checklist on the branch page should be mostly green.

| Port | What |
|---|---|
| 5173 | Dashboard |
| 8000 | Backend (`SIM_BACKEND_PORT` for the fake clock runner) |
| 8123 | World (the backend's `AI_SERVICE_URL`) |
| 8001 | Real AI service (`--real-ai`) |
| 1883 | MQTT broker (`--mqtt-port`) |

**If you re-run `seed_dev.py`**, it resets the door board's key to its fixed
dev value: run `setup_sim.py devices` again and restart the world.

### 2.3 Driving the world: `w.py`

```bash
python tools/sim/w.py <command>      # no arguments: the full list
```

| Command | What happens |
|---|---|
| `add NAME visitor|employee AT TO [rfid=..] [face=..] [weapon=..]` | Someone appears at AT and walks to TO |
| `move NAME PLACE` / `teleport NAME PLACE` | Walks / jumps there |
| `leave NAME` / `remove NAME` | Walks out / vanishes |
| `set NAME weapon=pistol emotion=Anger wanted=NAME face=NAME` | Changes what the cameras see on them (`none` clears) |
| `lose NAME [SECONDS] [to=PLACE]` | Tracking loses them; they come back as a new track |
| `kiosk NAME SERVICE` | They press the kiosk button (service code or name) |
| `callnext SERVICE` | The counter's call-next button |
| `gate NAME` | They badge at the gate (uses their `rfid=`) |
| `door NAME ROOM` | They badge at a badge room door (`ROOM`: part of its name) |
| `sensor temperature=33 gas_co=40 [jump] [now]` | Sensors drift (or jump) to these values |
| `fire PLACE [smoke]` / `fire clear` | Fire or smoke in view of the cameras |
| `ai down` / `ai up` | The AI service stops / comes back |
| `clock` / `clock HH:MM` | Read / move the backend's fake clock (your computer's timezone) |
| `real` / `real PART on\|off` | Show / change what is simulated and what is real (2.4) |
| `state` / `log [SINCE]` / `places` | What the world looks like, what it did, the named places |

Places: `outside`, `door`, `entrance`, `kiosk`, `waiting`, `waiting2`,
`waiting3`, `counter1`, `desk1`, `counter2`, `desk2`, `office3`, `desk3`,
`office4`, `desk4`, `bureau`, `bureau_door`, `technique`, `center`, or
`zone:NAME` for the middle of a zone you drew.

**Recipes:**

| To see | Do |
|---|---|
| A ticket linked to a person on the live map | `add V1 visitor outside kiosk`, wait, `kiosk V1 VIR` |
| An employee named on the live map | `add M employee outside entrance rfid=RFID-DEV-MANAGER`, wait, `gate M` |
| Counter staffing | Move an employee to `desk1` / away from it |
| A weapon alert and the red ring | `add A visitor outside waiting weapon=pistol` |
| A watchlist alert | Enroll a photo on **Watchlist** as `SUSPECT-1`, then `set V1 wanted=SUSPECT-1` |
| Temperature / gas alerts, fan, emergency unlock | `sensor temperature=33 jump now`; `sensor gas_co=60 jump now` (any value above the critical threshold set on the device unlocks the doors) |
| Badge + face doors | Set a room to Badge + face with door camera `cam4`, enroll the employee's face on their record, then `add M employee bureau_door rfid=... face=emp-<employee id>` and `door M <room>` (try without `face=` for "Visage non reconnu") |
| Restricted zones | Set a zone to Staff only, `gate` an employee in, send a visitor into the zone |
| A lost employee | `lose M 1` (hand-off keeps them), `lose M 4` (false alarm to fix by hand) |
| AI outage alerts | `ai down`, wait about a minute, `ai up` |
| End of day | `clock 17:00`: waiting tickets become no-show within a minute |

### 2.4 Simulated or real

Each part of the branch can be simulated by the world or be the real thing:

| Part | Simulated | Real |
|---|---|---|
| `cameras` | The world's people, cameras and detections | Real cameras watched by the real AI service: the backend's `AI_SERVICE_URL` points at the AI service (8001), not at the world |
| `kiosk`, `gate`, `display`, `door` | The world plays the board | The board itself, registered on the Devices page with its own key |

```bash
python tools/sim/w.py real                  # what is simulated, what is real
python tools/sim/w.py real kiosk on         # several: real kiosk=on gate=on
```

The choice lives in `sim_config.json` (`"real"`). The world reads it live: it
stops publishing sensor readings, polling the kiosk or answering MQTT for a real
board, and refuses the commands that would play it. Choose before
`setup_sim.py devices`, which then leaves real boards and their keys alone.

Real boards and cameras stamp real time, so as soon as anything is real, run
the backend on the real clock (`uvicorn app.main:app`), not `run_fake_clock.py`.

### 2.5 Scenarios: replayable days

Write the commands in a text file and play it:

```bash
python tools/sim/play.py tools/sim/scenarios/full_day.txt
python tools/sim/play.py tools/sim/scenarios/full_day.txt --from "Opening"
```

| Line | What it does |
|---|---|
| `section NAME` | A part of the scenario; `--from NAME` starts there |
| `say TEXT` | Printed to the tester ("watch the Alerts screen") |
| `do TEXT` | Something to do by hand ("calibrate cam1"); waits for Enter |
| `pause` / `wait 5` | Wait for Enter / 5 seconds |
| `clock HH:MM` | Moves the fake clock; on the real clock it only shows the story's time |
| `COMMAND >> TEXT` | A `w.py` command. When the part it plays is real, TEXT is shown as what to do in real life ("press Virement on the kiosk") and the player waits for Enter |

A command's part: people, fire and `ai` are the cameras; `kiosk`, `gate`,
`door`, `callnext` (display) and `sensor` (door board) are the boards. A real
command with no `>>` text is skipped. A failing command asks: retry, skip or
quit.

`tools/sim/scenarios/full_day.txt` is a whole working day from an empty app:
setting up the stack, the branch, the boards and the cameras (calibration,
alignment, zones), then 07:45 to closing: staff badging in, the opening rush
on two counters, temperature and gas alarms, a refused door, an armed visitor,
a wanted person at the kiosk, the AI service going down, lunch, a returning
visitor and the end of the day. `demo_day.txt` is a short version.

### 2.6 The fake clock

`run_fake_clock.py` starts the backend at the time you give and lets it tick in
real time. `w.py clock 09:30` jumps it. The browser follows it only with
`vite.sim.config.ts`; the world follows it on its own.

- **Restart at the current fake time** (`w.py clock` first), or the day jumps
  back to the start time.
- Times are UTC inside; `w.py clock HH:MM` reads HH:MM in your computer's
  timezone, which is what the dashboard shows.
- Without the fake clock everything still works, on real time.

### 2.7 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Device requests refused (401 "Clé appareil invalide") | Keys changed (re-seed, rotation): `setup_sim.py devices`, restart the world |
| Live map empty, tracking "idle" | cam1/cam2 not calibrated, aligned or registered: `setup_sim.py vision` |
| Zone counts stay 0 | The zone is a pixel zone, or nobody stands inside it: `w.py state` shows counts; use `zone:NAME` places |
| Dashboard times are off by hours | Use `vite.sim.config.ts`; check your computer's timezone |
| A weapon detection does not open a new alert | An older weapon alert of the branch is still open: one incident per branch; resolve it |
| World restarted, people gone | People are saved in `tools/sim/world_people.json`; delete it for an empty floor |
| `setup_sim.py` cannot reach the world | Start the world before `vision` |

### 2.8 Starting over

Stop everything, then: delete `tools/sim/sim_config.json` and
`tools/sim/world_people.json`, recreate the database (`alembic upgrade head`,
`python seed_dev.py`), clear the AI service's `ai/features/data/`, and run the
setup steps again.

---

## Part 3. Testing with an AI assistant

Live mocking was designed to be driven by a person narrating and an assistant
operating the simulation: "the agent arrives", "a visitor takes a ticket",
"the temperature climbs". You watch the screens and judge; it plays every
camera and device.

### 3.1 How a session works

1. **Setup**: the assistant runs part 2.2 (or checks it is running) and gives
   you the dashboard address and a login.
2. **Narrate**: you say what happens next, in plain words. The assistant turns
   it into `w.py` commands, runs them, and tells you which screen to watch
   **before** acting.
3. **Notes**: when something looks wrong, say so. The assistant writes it down
   in a notes file and **does not stop to investigate or fix it**; the test
   continues.
4. **After the test**: go through the notes together, fix them, re-run the
   scene that showed each one.

### 3.2 Briefing to give the assistant

Paste this at the start of the session:

```text
We are testing SmartAgency end to end with the live world mock described in
docs/mocking-guide.md (part 2). Read that guide and docs/user-guide.md first.

Your role: you play every person, camera and device through
`python tools/sim/w.py ...` (and play.py for scripted scenes). I play the staff
in the dashboard and narrate what happens.

Rules:
- Before each action, tell me which screen to watch.
- Use the fake clock (w.py clock HH:MM) to move through the day; never restart
  the backend without reading the current fake time first.
- When I report a problem, append it to docs/test-notes.md (numbered, with what
  I saw and what I expected) and continue. Do not investigate or fix anything
  during the test unless I say so.
- Before blaming the app, check whether the simulation caused it (wrong place,
  wrong key, person not in the zone): say which.
- Only touch the local development stack. Never real devices or real data.
```

### 3.3 Tips

- Ask for one event at a time when you want to watch it happen; ask for a
  "rush" when you want load.
- Ask "what does the world look like?" (`w.py state`) when the screens and
  your expectations disagree.
- Keep the notes file in the repo while you test; it becomes the fix list.
