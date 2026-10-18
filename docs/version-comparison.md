# This version compared with `master`

A side-by-side of what this version of SmartAgency contains next to `master` as
of 2026-10-14 (last merge: PR #130). Everything below was measured from the code
of both versions, not from plans or tickets.

The [user guide](user-guide.md) and [developer guide](developer-guide.md)
describe this version in full.

---

## At a glance

| | `master` | This version |
|---|---|---|
| Backend routes | 102 | 149 |
| Dashboard screens | 21 | 28 |
| Backend tests | 37 | 503 |
| Frontend tests | 378 | 473 |
| Database migrations | 20 | 38 |
| Database tables | 19 | 24 |
| Background services | 4 | 10 |
| Backend code (lines, excluding migrations) | 8,200 | 13,500 |
| Frontend code (lines, excluding tests) | 25,000 | 35,900 |
| API contract (`api.md`, lines) | 2,067 | 3,951 |
| Hardware contract | `ingestion.md` (809 lines) | `ingestion.md` (897 lines) + `device-commands.json` |

Both versions build cleanly and pass their own test suites. In both, every
route the dashboard calls exists in the backend.

---

## Feature by feature

### Security and alerts

| | `master` | This version |
|---|---|---|
| Camera alerts stored (weapon, fire, watchlist) | Yes | Yes |
| Acknowledge / resolve an alert from the dashboard | No | Yes |
| Weapon and watchlist alerts stay open until a person closes them | No, they close when the camera stops seeing the subject | Yes, with "out of view since" |
| One subject seen by several cameras = one alert | No | Yes |
| "Needs attention" list of every active alert (sensors, systems, cameras) | No | Yes |
| Critical alert notifications on phone / desktop (Web Push, email fallback) | No | Yes |
| "AI service down" / "sensor network down" alerts | No | Yes |
| Restricted zones (Staff only / Nobody) with intrusion alerts | No | Yes |
| Alert when restricted zones go unwatched | No | Yes |
| Weapon marker and intruder marker on the live map | No | Yes |
| Doors unlock on critical gas/CO or fire | No | Yes |
| Doors lock on a confirmed weapon (per-branch setting) | No | Yes |
| Choose which detections each camera runs | No, every camera runs every detection | Yes |

### Doors, badges and staff

| | `master` | This version |
|---|---|---|
| Badge at the gate, badge rooms | Yes | Yes |
| Badge rooms managed from the dashboard | No | Yes |
| Badge + face doors (face checked once at the tap, fails closed) | No | Yes |
| Employee face photos for doors, managed on the employee record | Backend only, no screen | Yes |
| Failed badge attempts logged, per-door view | No | Yes |
| Staff named on the live map after badging | No | Yes, with automatic and manual correction |
| Offboarding (an inactive employee loses their login, faces and tracking link) | No | Yes |
| Manual door controls | Placeholder screen | Lock / Unlock buttons, confirmed by the device |
| Device key rotation confirmed and audit-logged | No | Yes |

### Queue and visitors

| | `master` | This version |
|---|---|---|
| Kiosk tickets, agent call / complete / cancel | Yes | Yes |
| Start service and skip (no-show) | No | Yes |
| Counters managed from the dashboard | No | Yes |
| Managers can cover a counter | No | Yes |
| Tickets still waiting at closing become no-show | No, they carry over to the next day | Yes |
| Returning visitors recognised by face (no identity stored), history shown to the agent | No | Yes |
| Queue warnings per service | No | Yes |
| Ticket layout editor | Backend only, no screen | Yes |

### Monitoring and management

| | `master` | This version |
|---|---|---|
| Climate | Outdoor city weather only | Outdoor weather and the branch's own sensors |
| Live map of people on the floor | No | Yes |
| Counter staffing (is someone at the counter) | Yes | Yes |
| Insights: satisfaction, waiting times, trends, counter and service performance | No | Yes |
| Device uptime history | No | Yes |
| Branch comparison | No | Yes |
| Reports (one branch, all branches) | No | Yes |
| Announcements | No | Yes |
| Branch page with setup checklist | No | Yes |
| AI tuning screen (change detector settings live) | No | Yes |
| Face enrollment screen | No | Yes |

### AI configuration and branches

| | `master` | This version |
|---|---|---|
| Calibration, alignment, cross-check, entry gates | Yes | Yes, plus bird's-eye view and zones redrawn after recalibration |
| Calibration and tracking sources limited to the user's branch | Yes | Yes |
| Watchlist entries owned by a branch, audit-logged | Yes | Yes, faces too |
| Zones | Yes | Yes, plus "who may be here" |

### Engineering

| | `master` | This version |
|---|---|---|
| Test that every route needs a login and matches its documented roles | No | Yes |
| Test that every route is in the API contract | No | Yes |
| Mock mode answers every endpoint the dashboard calls | Yes | Yes, guarded by a test |
| Manual device commands defined in one shared file, checked against the hardware contract | No | Yes |
| Firmware/contract drift reported to the operator | No | Yes |
| Stale tracking data dropped automatically | No | Yes |
| User guide and developer guide | No | Yes |

---

## What adopting this version means

**Database**: the two migration histories have diverged. This version has 38
migrations with a single head; `master` has 3 that this version does not
(`d4e6f8a0b2c4` AI workstations, `g1b2c3d4e5f6` wanted people,
`h2c4d6e8f0a2` unique camera stream URL), each covered here in another form
(workstations are kept by the AI service, watchlist ownership is
`gallery_entries`, stream-URL uniqueness is `a1d3f5b7c9e2`). A fresh database
needs only `alembic upgrade head`; a database already migrated by `master` needs
a one-off reconciliation of those three revisions first.

**Backend settings**: new optional settings, all with defaults, listed in
`backend/.env.example` and the developer guide (notifications, health monitor,
device uptime, badge + face timeout, people tracking and restricted zones,
manual controls).

**API contract**: every new route is documented in `contracts/api.md`; the
existing routes keep their shapes.

**Hardware** (`contracts/ingestion.md`; the firmware-side checklist is
[hardware-changes.md](hardware-changes.md)):
- The door reader must allow **10 seconds** for a door-access answer in a
  badge + face room, and show a "look at the camera" prompt meanwhile.
- The door controller must implement the commands listed for its type in
  `contracts/device-commands.json` (today: `lock`, `unlock`) and answer
  `unknown_action` to anything else.
- Door controllers receive `lock` / `unlock` commands over MQTT (automatic on
  gas/fire/weapon, and manual from the dashboard); both `DOOR` and
  `ACCESS_SENSORS` devices receive them.

**AI service**: no change required. This version uses the routes `master`'s AI
service already has.
