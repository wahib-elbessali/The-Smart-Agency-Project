# AI/CV Service Contract

One process, one port: `uvicorn features.main:app --port 8000` (local models) or
`uvicorn features.cloud.main:app --port 8000` (same routes, models on a molab GPU — see
`features/cloud/README.md`). Ten features mounted under per-feature prefixes, plus four app-level
routes.

**No authentication.** Every endpoint is open to anyone who can reach the port — there is no API
key, no token, no header to send. Three surfaces make this a deployment constraint rather than a
convenience: `/wanted/alerts/stream` broadcasts the names of people flagged as wanted **with a photo
of them attached**, and `/face` and `/wanted` both read out stored biometric embeddings. This
service must sit behind an authenticating reverse proxy with TLS; it is not safe on an open network.

**Configuration is a file, not environment variables.** The service reads none. Tunables
(detector confidence, image sizes, poll intervals, the wanted-list threshold) live in
`features/config.json` and are read at startup (and on `POST /config/reload`) — see `GET /config`. File locations are fixed
inside the package and are not configurable at all. Most can be changed while it runs with `PATCH /config`.

**Everything the service writes** — zones, calibration, both face galleries, employee-activity
workstations — goes to `features/data/`, a fixed path relative to the package. It does **not**
follow the working directory, so the service behaves identically under a shell, systemd or Docker.
A fresh install starts empty.

---

## App-level

### GET /
**Type:** REST
**Payload:** none
**Returns:**
```json
{"service": "smartAgencyAI",
 "features": ["/cameras", "/calibration", "/zoning", "/employee_activity", "/people",
              "/face", "/weapon", "/fire", "/emotion", "/wanted"],
 "routes": [{"path": "/frame", "methods": ["GET"]}, "…"]}
```
**Notes:** Route map, so a caller can discover the surface without parsing OpenAPI (also served at `/docs`). The cloud app (`features.cloud.main:app`) returns the identical shape plus one extra route, `GET /detector`.

### GET /frame
**Type:** REST
**Payload:** query `?camera=<id>` (preferred) or `?source=<rtsp url or file path>`, plus optional `&index=`, `&format=png|jpeg`, `&quality=`
**Returns:** `200 image/png` (or `image/jpeg` if requested) — raw frame bytes, not JSON
**Notes:** `404` if the source can't be opened or that frame can't be read, or if `camera` isn't in the camera table. `camera=` looks up both the URL **and** the per-camera `quality` from the table, so the image returned is the same size the detectors actually see — important for anything overlaying boxes on it. `source=` alone returns the camera's native resolution regardless of table quality. `index` omitted = whatever frame the source is currently at (frame 0 on a fresh open for a file; the newest frame for a live stream). Shared by every feature — how a frontend gets something to click on for calibration points / zone polygons.

### GET /video_meta
**Type:** REST
**Payload:** query `?source=...`
**Returns:**
```json
{"n_frames": 2955, "fps": 25.0, "width": 360, "height": 288}
```
**Notes:** `404` if unopenable. `fps` falls back to `25.0` if the source reports none. `n_frames` is always `0` for a live stream (RTSP/HTTP) — arithmetic on it there is meaningless.

### GET /config
**Type:** REST
**Payload:** none
**Returns:**
```json
{"config": {
   "detector": {"backend": "auto"},
   "zoning":  {"weights": null, "imgsz": 1280, "conf": 0.25, "update_interval": 2.0},
   "weapon":  {"conf": 0.25, "imgsz": 640,  "update_interval": 2.0},
   "fire":    {"conf": 0.25, "imgsz": 1280, "update_interval": 2.0},
   "emotion": {"det_size": 640, "update_interval": 2.0},
   "wanted":  {"threshold": 0.5, "min_face_px": 30, "det_size": 640,
               "update_interval": 2.0, "confirm_cycles": 2, "hold_cycles": 5},
   "employee_activity": {"poll_interval": 2.0, "absence_seconds": 300.0},
   "person_tracking": {"weights": null, "conf": 0.25, "update_interval": 2.0,
               "gate_pw": 1.638, "revive_pw": 5.5, "dup_guard_pw": 0.85,
               "max_lost_s": 24.0, "stale_gate_s": 0.4, "room_trim_pct": 1.0,
               "cam_support_min": 2, "peak_min": 0.55, "foot_sigma_pw": 0.725,
               "diffusion_revive": false},
   "face": {"pack": "buffalo_s"}},
 "config_file": "…/features/config.json",
 "data_dir":    "…/features/data",
 "models_dir":  "…/features/models"}
```
**Notes:** The effective settings (`config`), how each key can be changed (`apply_modes`: `live` = next detection cycle, `next_start` = used when `/people` next bootstraps, `restart` = needs a restart), what the file said at boot (`startup_config`, so a live change shows as a difference), and restart-mode values already written to `config.json` but not running yet (`pending_restart`). Change values with `PATCH /config`.

### PATCH /config
**Type:** REST
**Payload:** `{"changes": {"weapon": {"conf": 0.4}, "wanted": {"threshold": 0.55}}, "persist": false}`
**Returns:** `{"applied": {"weapon": {"conf": {"value": 0.4, "mode": "live"}}}, "pending_restart": {}, "previous": {"weapon": {"conf": 0.25}}, "persisted": false}`
**Notes:** Changes tunables while the service runs: no restart, cameras stay registered, live keys apply within that feature's `update_interval`. All-or-nothing: any invalid value returns `422` `{"detail": {"message": "config not changed", "errors": [...]}}` listing every problem, and nothing changes. Unknown sections/keys, wrong types, out-of-range values (`conf` in (0,1], `imgsz` a multiple of 32, `wanted.threshold` at or above its floor, …) are all `422`. `restart`-mode keys (`*.weights`, `detector.backend`, `face.pack`, `emotion.det_size`, `wanted.det_size`) are refused unless `persist` is `true`; they are then written to `config.json` and returned under `pending_restart`. Without `persist` a change lasts until the process restarts. With `persist: true` the changed values are also merged into `config.json` (atomic replace). `PUT /wanted/threshold` still works and shares state with this endpoint.

### POST /config/reload
**Type:** REST · **Payload:** none
**Returns:** same shape as `PATCH /config`.
**Notes:** Re-reads `config.json` and applies whatever differs from what is running: live keys now, restart keys reported under `pending_restart`. For editing the file by hand and applying it without a restart. All-or-nothing: a bad value anywhere in the file returns `422` and applies nothing.

**Which keys change how** (`apply_modes` in `GET /config` is the authoritative, machine-readable version of this table):

| Mode | Keys | Takes effect |
|---|---|---|
| `live` | `weapon.{conf,imgsz,update_interval}`, `fire.{conf,imgsz,update_interval}`, `zoning.{conf,imgsz,update_interval}`, `emotion.update_interval`, `wanted.{threshold,min_face_px,update_interval,confirm_cycles,hold_cycles}`, `employee_activity.{poll_interval,absence_seconds}`, `person_tracking.{conf,update_interval}` | next detection cycle, within that feature's `update_interval` |
| `next_start` | `person_tracking.{gate_pw,revive_pw,dup_guard_pw,max_lost_s,stale_gate_s,room_trim_pct,cam_support_min,peak_min,foot_sigma_pw,diffusion_revive}` | stored immediately, used the next time `/people` bootstraps (camera set changes, or the service restarts) |
| `restart` | `*.weights`, `detector.backend`, `face.pack`, `emotion.det_size`, `wanted.det_size` | only after a restart. `det_size` is restart-only because the face engine shared by `/face`, `/wanted` and `/emotion` is prepared once at a fixed size; changing it while running would silently do nothing |

**Validation.** A key's type must match its default (`bool` is not accepted for a number, `null` only where the default is `null`). Ranges: `conf` in (0, 1]; `imgsz` in [32, 4096] and a multiple of 32; every interval in [0.05, 3600] seconds; `wanted.threshold` in [floor, 1.0], the same floor `PUT /wanted/threshold` enforces; `wanted.min_face_px` in [16, 1000]; `wanted.confirm_cycles` in [1, 100]; `wanted.hold_cycles` in [0, 1000]. Unknown sections and keys are errors that list the valid names.

**Persistence.** Without `persist`, a change lives in the running process only and `config.json` stays the durable default. With `persist: true` the values are merged into `config.json` first (temp file, then atomic replace) and then applied; if the write fails nothing is applied. A `restart`-mode key is written to the file, listed under `pending_restart` in the response and in `GET /config`, and the running value stays unchanged until the next start.

**Example: tighten weapon detection and slow its polling, live.**
```
PATCH /config
{"changes": {"weapon": {"conf": 0.4, "update_interval": 3.0}}}
→ 200
{"applied": {"weapon": {"conf": {"value": 0.4, "mode": "live"},
                        "update_interval": {"value": 3.0, "mode": "live"}}},
 "pending_restart": {},
 "previous": {"weapon": {"conf": 0.25, "update_interval": 2.0}},
 "persisted": false}
```

**Example: a restart-only key.**
```
PATCH /config   {"changes": {"face": {"pack": "buffalo_l"}}}
→ 422  {"detail": {"message": "config not changed",
        "errors": ["face.pack only changes on restart; send persist=true to write it to config.json for the next start"]}}

PATCH /config   {"changes": {"face": {"pack": "buffalo_l"}}, "persist": true}
→ 200  {"applied": {}, "pending_restart": {"face": {"pack": "buffalo_l"}}, "previous": {}, "persisted": true}
```
(Changing `face.pack` also requires re-enrolling every face; galleries from different packs do not match reliably.)

**Example: one invalid value rejects the whole request.**
```
PATCH /config   {"changes": {"weapon": {"conf": 0.4}, "fire": {"imgsz": 7}}}
→ 422  {"detail": {"message": "config not changed", "errors": ["fire.imgsz must be in [32, 4096], got 7"]}}
```
`weapon.conf` is unchanged.

**Relation to `PUT /wanted/threshold`.** Both change the same running state; `GET /config` and `GET /wanted/threshold` agree after either one. `PUT /wanted/threshold` is kept as-is for existing callers.

---

## /cameras — the site camera table

The camera table every other feature reads from. Define a camera once (id, URL, quality), then tick
which features watch it — a feature's own `POST .../sources` (below) writes into this same table,
so the two are two entry points to one truth, not two separate registries.

### GET /cameras
**Type:** REST · **Payload:** none
**Returns:** `{"cameras": {"0": {"name": "Entrance", "url": "rtsp://…", "quality": 1.0, "features": ["people", "zoning"]}}, "valid_features": ["people", "zoning", "weapon", "fire", "emotion", "wanted"]}`

### POST /cameras
**Type:** REST
**Payload:** `{"id": "0", "url": "rtsp://…", "name": "Entrance", "quality": 1.0, "features": ["people", "zoning"]}` — only the fields sent are changed
**Returns:** `{"id": "0", "camera": {…}, "warnings": [...]}`
**Notes:** `warnings` flags a camera assigned to `people`/`zoning` with no calibration yet, or a calibration that predates resolution-tracking (can't be safely rescaled if quality changes) — not decorative, same as `/zoning/zones`'s warnings.

### DELETE /cameras/{id}
**Type:** REST · **Payload:** none · **Returns:** `{"id": "0", "deleted": true}`

### PUT /cameras/{id}/features
**Type:** REST
**Payload:** `{"features": ["people", "zoning"]}` — replaces the full list for this camera
**Returns:** `{"id": "0", "camera": {…}, "warnings": [...]}`
**Notes:** This is the general mechanism — a feature's own `POST .../sources` is a convenience wrapper that does the same table write plus sets the URL in one call. `404`-equivalent behaviour: silently no-ops on a camera with no `url` set yet (a half-finished row is never handed to a feature).

### PUT /cameras/{id}/quality
**Type:** REST
**Payload:** `{"quality": 0.5}` — fraction of native resolution, `0.05`–`1.0`
**Returns:** `{"id": "0", "camera": {…}, "warnings": [...]}`
**Notes:** Cannot break calibration — the homography is rescaled from the frame's actual size at read time, not trusted from this number. If the camera is assigned to `/people` and it's currently `running`, this **re-bootstraps it and drops every track id** — reported in `warnings`, not done silently.

---

## /calibration — pixel ↔ floor geometry (one-time per-site setup)

### GET /calibration
**Type:** REST · **Payload:** none
**Returns:** `{"0": {"Hinv": [[…]], "diagnostics": {...}}}` — one entry per calibrated camera, `{}` if none yet. `Hinv` maps image pixels → floor centimetres.

### POST /calibration/rect
**Type:** REST
**Payload:** `{"camera": "0", "points": [[120,430],[980,410],[1010,700],[95,720]], "img_w": 1920, "img_h": 1080}` — exactly 4 points, in order around an assumed right angle
**Returns:**
```json
{"n_points": 4, "px_err_mean": 2.9e-13, "px_err_max": 3.4e-13,
 "aspect_source": "vanishing-point inference", "inferred_aspect": 1.78,
 "aspect_stability_std": 0.02, "aspect_confident": true,
 "calib_res": [1920, 1080], "aligned": false, "note": "…"}
```
**Notes:** `img_w`/`img_h` are **required** — the orthogonality solve needs the image centre as an assumed principal point, and `calib_res` (recorded from them) is what lets this calibration be safely rescaled if the frame size ever changes. The rectangle's true aspect ratio is **inferred** from the 4 points' own perspective geometry, not assumed square — `aspect_confident: false` (or `aspect_source` starting with `"fallback"`) means the geometry was too degenerate to trust and a square was guessed; treat the result as provisional and either re-click a larger, clearer rectangle or fix it via `/calibration/align` with ≥4 shared points instead (that replaces the homography outright). `422` if not exactly 4 points or near-collinear. **Do not treat `px_err_*` as validation** — a 4-point exact fit always reports ~0 error by construction. Result is `aligned: false` until `/calibration/align` reconciles it into the shared frame.

### POST /calibration/align
**Type:** REST
**Payload:** `{"points": [{"0": [512,300], "1": [140,290]}, {"1": [820,150], "2": [110,180]}]}` — the **full accumulated list** of shared-point observations, not a delta
**Returns:**
```json
{"reference": "0",
 "results": {"0": {"aligned": true,  "reference": true,  "n_points": null, "via": null},
             "1": {"aligned": true,  "reference": false, "n_points": 2, "via": "0", "fit": "homography"},
             "2": {"aligned": false, "reference": false, "n_points": 0, "via": null,
                   "error": "no chain of >=2-point camera pairs connects this camera back to the reference"}},
 "results_warning": null,
 "residual_checks": [{"pairs": [{"cam_a": "0", "cam_b": "1", "distance_cm": 0.0}]}]}
```
**Notes:** BFS from the most trustworthy already-calibrated camera (not necessarily the lowest id). Fits the **strongest transform the point count supports** per camera pair — a full homography with ≥4 shared points (repairs perspective, the clicked rectangle's own error drops out entirely), affine with exactly 3 (repairs aspect/shear, not perspective), similarity only below 3 (cannot repair a wrong aspect — reproduces it) — `results[cam]["fit"]` names which one ran. `400` if fewer than 2 cameras calibrated. **Check `results` per camera** — one that couldn't be reached comes back `aligned: false` with an `error` string, and the call still returns `200`. `results_warning` is set when every calibrated camera's rectangle aspect had to be guessed (the fallback above) — the whole shared frame's shape is then a guess too. `residual_checks` shows how far apart cameras now place each recorded point; small numbers mean the alignment took.

### POST /calibration/cross_check
**Type:** REST
**Payload:** `{"points": {"0": [512,300], "1": [140,290]}}` — ≥2 cameras, already aligned
**Returns:** `{"worlds": {"0": [45.7,-45.6], "1": [45.7,-45.6]}, "pairs": [{"cam_a": "0", "cam_b": "1", "distance_cm": 0.0}]}`
**Notes:** Read-only verification — click the same real point in ≥2 aligned cameras, get back how far apart they place it. Use points different from the ones used to align, or you're checking the fit against its own training data. `422` if any named camera is uncalibrated or unaligned.

### GET /calibration/gates
**Type:** REST · **Payload:** none · **Returns:** `{"gates": [[x_cm, y_cm], ...]}`

### POST /calibration/gates
**Type:** REST
**Payload:** `{"gates": [{"camera": "0", "points": [[120,430],[140,460]]}]}` — **replaces** the whole gate list
**Returns:** `{"gates": [[x_cm, y_cm], ...], "n": 2, "saved": "…/features/data/gates.json"}`
**Notes:** Entry/exit points, world coordinates — used by `/people`'s tracker as a revival prior (an unmatched detection far from every gate is assumed to be an existing person whose position drifted, not someone new). Each referenced camera must already be calibrated (`422` otherwise); points convert via that camera's current `Hinv`.

### DELETE /calibration/gates
**Type:** REST · **Payload:** none · **Returns:** `{"gates": [], "n": 0, "saved": "…"}`

### DELETE /calibration/{camera}
**Type:** REST · **Payload:** none · **Returns:** `{"camera": "0", "deleted": true}` / `404` if unknown.

---

## /zoning — headcount inside floor polygons (no identities/trajectories)

### POST /zoning/zones
**Type:** REST
**Payload:** `{"name": "lobby", "camera": "0", "polygon": [[100,200],[400,200],[400,500],[100,500]], "sources": {"0": "rtsp://…", "1": "rtsp://…"}}`
**Returns (pixel — one camera in `sources`):** `{"name": "till", "mode": "pixel", "saved": "…", "sources_known": ["0"], "warnings": []}`
**Returns (world — two or more):** `{"name": "lobby", "mode": "world", "saved": "…", "sources_known": ["0","1"], "warnings": [], "polygon_m": [[…]], "converted_from": {"camera": "0", "polygon_px": [[…]]}}`
**Notes:** Mode is inferred from `sources` count: 1 camera → `pixel` (that camera's own raw detections, no calibration needed), 2+ → `world` (drawn-on camera must be calibrated **and** aligned, else `422`). `camera` must be one of `sources` or `422` (prevents a silent-permanent-zero misconfiguration). `sources` accumulates into the site camera table across calls — registering cameras one call at a time costs nothing. Re-posting an existing `name` overwrites it, including mode. **World zones no longer run their own multi-camera fusion** — they read `/people`'s live tracked positions instead. This REQUIRES `/people` to be `running` for that camera set (`POST /people/sources`, check `GET /people/status`); if it isn't, `warnings` says so explicitly (`"'/people' is not currently running … this zone will count 0 until it is"`) rather than a silent, indistinguishable zero.

### GET /zoning/zones
**Type:** REST · **Payload:** none
**Returns:** `{"till": {"mode": "pixel", "camera": "0", "polygon_px": [[…]]}, "lobby": {"mode": "world", "polygon_m": [[…]], "converted_from": {…}}}` (`{}` if none exist)

### DELETE /zoning/zones/{name}
**Type:** REST · **Payload:** none · **Returns:** `{"name": "lobby", "deleted": true}` / `404`.

### WS /zoning/occupancy/stream
**Type:** WebSocket
**Payload:** optional query `?threshold=N` (default 0), per-connection
**Messages:**
```jsonc
// on connect
{"type":"snapshot","zones":{"lobby":{"count":4,"points":[[210.5,533.0]],"people_tracking_ready":true}}}
// then, on a real change
{"type":"update","zone":"lobby","count":5,"points":[[210.5,533.0]],"people_tracking_ready":true}
```
**Notes:** `points` are floor centimetres for world zones, pixel foot-points for pixel zones. A person can be in several overlapping zones at once; boundary counts as inside. `people_tracking_ready` is always `true` for a pixel zone; for a world zone it reflects whether `/people` is currently `running` — `false` means `count: 0` means "not tracking yet", not "genuinely empty", and a flip on that field pushes an update even if `count` didn't change. Pushed only on a real change (count crossing `threshold`, or the readiness flip) — no heartbeat. Detection runs continuously once ≥1 zone exists, whether or not anyone's listening.

---

## /employee_activity — presence/absence per workstation

Built entirely on `/zoning`'s already-computed occupancy — no face recognition, no model of its own. A "workstation" is a name bound to an existing `zoning` zone (create the zone first).

### POST /employee_activity/workstations
**Type:** REST
**Payload:** `{"name": "desk1", "zone": "till"}` — `zone` must already exist in `/zoning`
**Returns:** `{"name": "desk1", "zone": "till", "status": "unknown", "since": 1787600000.0, "zone_known": false}`
**Notes:** `422` if the named zone doesn't exist yet.

### GET /employee_activity/workstations
**Type:** REST · **Payload:** none
**Returns:** `[{"name": "desk1", "zone": "till", "status": "present", "since": 1787600123.4, "zone_known": true}]`
**Notes:** `status` is one of `unknown` (not classified yet, or the zone hasn't been read even once), `present` (the zone had ≥1 person at the last poll, or continuously since), `away` (the zone has been continuously empty for ≥ `employee_activity.absence_seconds`, default 300s/5min). `present` fires immediately on any sighting; `away` only after the full continuous-absence window — a brief step-away does not read as "not working". `zone_known: false` means "not measured yet", distinct from a real empty reading.

### DELETE /employee_activity/workstations/{name}
**Type:** REST · **Payload:** none · **Returns:** `{"name": "desk1", "deleted": true}` / `404`.

### WS /employee_activity/status/stream
**Type:** WebSocket · **Payload:** none
**Messages:** `{"type":"snapshot","workstations":[...]}` on connect, then `{"type":"update", ...same shape as one GET row...}` each time a workstation's `status` actually flips.

---

## /people — live multi-camera person tracking (persistent identities + floor positions)

Unlike every other feature, this one has a real one-time bootstrap cost (~30s on a live source) before it tracks anything — no `POST /people/start`; it triggers automatically once ≥2 registered cameras are calibrated **and** aligned.

### GET /people/sources
**Type:** REST · **Payload:** none
**Returns:** `{"sources_known": ["0","1"], "calibrated": ["0","1"], "aligned": ["0","1"]}`

### POST /people/sources
**Type:** REST
**Payload:** `{"sources": {"0": "rtsp://…", "1": "rtsp://…"}}` — merges into the site camera table
**Returns:** `{"sources_known": [...], "calibrated": [...], "aligned": [...], "warnings": [...]}`
**Notes:** Adding/removing a camera here invalidates any current bootstrap and re-triggers one.

### DELETE /people/sources/{camera}
**Type:** REST · **Payload:** none · **Returns:** `{"camera": "0", "deleted": true}` — stops watching this camera; same re-bootstrap trigger.

### GET /people/status
**Type:** REST · **Payload:** none
**Returns:** `{"phase": "running", "warnings": [], "error": null, "person_scale": 33.1, "room": {...}, "fps": 25.0, "cams_bootstrapped": ["0","1"], "gates_loaded": 2, "active_tracks": 3}`
**Notes:** `phase` is `idle` → `bootstrapping` → `running`, or `error`. `active_tracks` is `null` until running.

### WS /people/tracks/stream
**Type:** WebSocket · **Payload:** none
**Messages:**
```jsonc
{"type":"snapshot","state":"running","tracks":[{"id":7,"x":210.5,"y":533.0,"hits":42,"misses":0}]}
{"type":"state", "phase":"running", ...}                             // on every phase transition
{"type":"tracks","tracks":[...],"boxes":{"0":[[x1,y1,x2,y2],...]}}   // every cycle, once running
```
**Notes:** `tracks` are the FULL confirmed-track snapshot each cycle (not diffed — a moving person's position changes almost every cycle by construction). `boxes` are pixel coordinates in the quality-scaled frame — the same space `GET /frame?camera=` returns, so an overlay lines up without rescaling.

**Tracking blind spot, worth knowing before deploying with few cameras:** `person_tracking.cam_support_min` (default 2) requires that many cameras' evidence to agree before a floor position is even a candidate detection — not a confidence discount, an outright exclusion. With exactly 2 cameras, anywhere only ONE can see is invisible to `/people`: no detection is produced there, an existing track freezes and waits up to `max_lost_s` (24s default) to revive, and someone who stays there the whole time is never tracked. `zoning` pixel-mode zones are unaffected (single-camera by design).

---

## /face — access control (event-triggered, request/response) + anonymous visitor capture

### POST /face/enroll
**Type:** REST (`multipart/form-data`)
**Payload:** `name` (str) + `image` (one photo, exactly one face)
**Returns:** `{"name": "employee1", "embeddings_count": 1}`
**Notes:** `embeddings_count` is cumulative across every photo ever enrolled for that name. `400` undecodable image, `422` if zero or ≥2 faces found.

### GET /face/faces
**Type:** REST · **Payload:** none
**Returns:** `[{"name": "employee1", "embeddings": [[512 floats], "…"]}]` (`[]` when empty) — full gallery including raw vectors, for a backend to mirror into its own DB.

### DELETE /face/faces/{name}
**Type:** REST · **Payload:** none · **Returns:** `{"name": "employee1", "embeddings_removed": 3}` / `404`. Removes every enrolled photo for that name. Touches only this gallery — the wanted watchlist is a separate file.

### POST /face/scan
**Type:** REST
**Payload:** `{"source": "rtsp://gate-cam", "timeout_seconds": 15}`
**Returns — four distinct outcomes, all `200`:**
```jsonc
{"source":"…","name":"omar","score":0.735,"timed_out":false,"error":null}   // recognised
{"source":"…","name":null,"score":0.002,"timed_out":false,"error":null}     // face seen, not recognised
{"source":"…","name":null,"score":null,"timed_out":true,"error":null}       // fine, nobody appeared
{"source":"…","name":null,"score":null,"timed_out":false,"error":"could not open source"}
```
**Notes:** **Blocking** — opens the source, watches until a face appears or the timeout elapses, answers on the same request. `error` vs `timed_out` are deliberately distinct: camera offline vs. camera fine but nobody showed. `409` if that source is already mid-scan. `score` is cosine similarity, not a probability; match threshold `0.248` (measured on 1000 LFW pairs: AUC 0.998, 0 false accepts in 500 negatives at 98.8% true-accept). The grant/deny decision belongs to whichever service consumes this result, not to this service.

### POST /face/capture
**Type:** REST
**Payload:** same as `/face/scan` — `{"source": "…", "timeout_seconds": 15}`
**Returns:** `{"source": "…", "image": "<base64 jpeg, 40% margin>", "bbox": [x1,y1,x2,y2], "det_score": 0.93, "embedding": [512 floats], "timed_out": false, "error": null}`
**Notes:** Same blocking watch-until-a-face-appears shape as `/face/scan`, but **touches no gallery** — no name in, no name out, no `identify()` call. For anonymous visitors (ticket-kiosk triggered): returns a photo + embedding and stops there. Deciding "new visitor vs. returning" and owning any resulting visitor id is 100% the caller's job — this service has no visitor gallery and no visitor-identity concept. Shares `/face/scan`'s `409` double-scan guard (keyed by source, not by route).

---

## The four alert streams — /weapon, /fire, /emotion, /wanted (identical shape)

Substitute `{f}` for `weapon`, `fire`, `emotion`, or `wanted`. Built on one shared implementation — learn one, you know all four; only the class vocabulary (and `/wanted`'s extra routes below) differs.

### POST /{f}/sources
**Type:** REST
**Payload:** `{"sources": {"cam1": "rtsp://…", "lobby": "/data/lobby.mp4"}}`
**Returns:** `{"sources_known": ["cam1","lobby"]}`
**Notes:** Merges into the site camera table (`POST /cameras` / `PUT /cameras/{id}/features` do the identical thing). Detection begins the moment ≥1 source exists, whether or not anyone's connected to the stream.

### GET /{f}/sources
**Type:** REST · **Payload:** none · **Returns:** `{"cam1": "rtsp://…"}` (`{}` when empty).

### DELETE /{f}/sources/{camera}
**Type:** REST · **Payload:** none · **Returns:** `{"camera": "cam1", "deleted": true}` / `404`.

### WS /{f}/alerts/stream
**Type:** WebSocket · **Payload:** none
**Messages:**
```jsonc
{"type":"snapshot","cameras":{"cam1":[{"class":"pistol","confidence":0.87,"bbox":[900.5,332.0,1352.5,664.7]}]}}
{"type":"update","camera":"cam1","detections":[{"class":"pistol","confidence":0.87,"bbox":[…]}]}
```
**Notes:** Fires only when a camera's **set of detected classes** changes — not per frame (confidence jitter alone sends nothing). `bbox` is `[x1,y1,x2,y2]` source-frame pixels. `"detections": []` is the all-clear. `/wanted` and `/face/capture`-adjacent entries may additionally carry `"held": true` for a re-emitted stale entry during hysteresis (see below) and a `"snapshot"` base64 JPEG on the highest-confidence detection.

### /weapon classes
`pistol`, `knife`. (The underlying model also sees `smartphone`, `monedero`, `billete`, `tarjeta` as lookalike-distractor training classes, but this feature only ever alerts on the two weapon classes.) Known flicker: pistol↔smartphone label can flip frame-to-frame on the same object — treat presence as reliable over a short window, not on one frame.

### /fire classes
`fire`, `smoke`.

### /emotion classes
`Anger`, `Contempt`, `Disgust`, `Fear`, `Happiness`, `Neutral`, `Sadness`, `Surprise` (one per face). Only trust this on a camera close to the interaction (counter/service desk) — confidence is genuinely low (0.4–0.6) on real candid footage even when working correctly; don't read sub-0.5 as "no signal."

### /wanted classes
`class` is the matched person's **name** — an open, operator-controlled vocabulary, unlike the fixed sets above, so a frontend can't hard-code per-class styling. Duplicate classes in one payload are legal (two faces both matching one name), so don't key by class. Adds the five routes below.

---

## /wanted — watchlist management (additional routes)

### POST /wanted/watchlist
**Type:** REST (`multipart/form-data`)
**Payload:** `name` + `image` (exactly one face)
**Returns:** `{"name": "SUSPECT-2024-114", "embeddings_count": 1}`
**Notes:** Names restricted to `[A-Za-z0-9 ._+-]`, 1–80 chars (`422` otherwise). Deliberately different route names from `/face/enroll` — enrolling someone into the wrong list is the catastrophic failure mode this guards against, and differently-named routes can't be confused for one another the way two identical ones could.

### GET /wanted/watchlist
**Type:** REST
**Payload:** optional query `?include_embeddings=true`
**Returns:** `[{"name": "SUSPECT-2024-114", "embeddings_count": 2}]`, plus `"embeddings": [[512 floats], …]` when opted in
**Notes:** Embeddings are opt-in, unlike `/face/faces` which always returns them.

### DELETE /wanted/watchlist/{name}
**Type:** REST · **Payload:** none · **Returns:** `{"name": "SUSPECT-2024-114", "embeddings_removed": 2}` / `404`. Touches only the watchlist — `/face`'s gallery is a separate file and provably cannot be affected.

### GET /wanted/threshold
**Type:** REST · **Payload:** none
**Returns:** `{"threshold": 0.5, "min_face_px": 30, "startup_default": {"threshold": 0.5, "min_face_px": 30}, "floor": 0.25, "watchlist_size": 3, "embeddings_total": 7, "applies_within_seconds": 2.0}`
**Notes:** `startup_default` is what `config.json` said at boot, so drift between that and the live value is visible.

### PUT /wanted/threshold
**Type:** REST
**Payload:** `{"threshold": 0.58}` — `threshold` and/or `min_face_px`, at least one required
**Returns:** `{"threshold": 0.58, "min_face_px": 30, "previous": {...}, "warnings": [...], "applies_within_seconds": 2.0}`
**Notes:** Takes effect on the next detection cycle, **not persisted** — a restart reverts to `config.json`. `422` below `floor` (0.25). Lowering below the measured default (0.50) succeeds but returns a `warnings` entry naming what you gave up.

### Wanted alert payload (inside the common `/wanted/alerts/stream` shape)
```json
{"class": "MAROUANE-B-2024-114", "confidence": 0.612, "bbox": [412.0,88.0,501.0,205.0],
 "det_score": 0.881, "face_px": 94, "snapshot": "<base64 jpeg>"}
```
**Notes:** `confidence` is cosine similarity in `[-1,1]` (typically 0.25–0.75), not a probability. `snapshot` (base64 JPEG, ~20KB, nothing written to disk) attaches once, to the highest-confidence detection. `face_px` under `min_face_px` (default 30) is discarded before matching.

**Hysteresis:** `confirm_cycles` (default 2) sightings before an alert, `hold_cycles` (default 5) consecutive misses before the all-clear. Alert latency is `(confirm_cycles − 1) × update_interval`; the all-clear lags by `hold_cycles × update_interval`. Held-window replays carry `"held": true` and a bbox up to that many cycles stale.

**`"detections": []` is ambiguous** between "nobody wanted is here", "no faces at all" and "camera pointed at a wall" — unknown people are never emitted, so this stream cannot double as a camera-liveness check. Use `GET /frame` for that.

**Unknown faces are never emitted anywhere** — not in the stream, not to disk, not to a log.

**A match is evidence for a human to review, never an automatic action.** Measured open-set on LFW (200-person watchlist, 400 impostor probes): `thr 0.50 → DIR 0.910, FAR 0.0000`. Read that `FAR` carefully — 400 probes only resolve false-alarm rate down to ~2.5e-3, so "0.0000" means *unmeasurably small at this sample size*, not zero; the honest bound is up to ~22 false alarms/camera/day, and a genuinely quiet camera would need ~100k probes (far beyond LFW) to demonstrate. 0.50 is chosen deliberately above the first-zero point (0.44) because real footage is harder than LFW's frontal photos, and `confirm_cycles=2` multiplies two largely independent false-match probabilities on top — which is where the real safety margin comes from. Face-recognition error rates are also not uniform across demographic groups, which no threshold setting can fix.

---

## Cloud variant (`features.cloud.main:app`)

Identical routes, identical payloads, identical responses — same `app` object, not a reimplementation. Every model (person, weapon, fire, face detect+embed) runs on a molab GPU instead of locally; POM fusion, the tracker, calibration, zones, and gallery matching always stay local. One addition:

### GET /detector
**Type:** REST · **Payload:** none · **Only exists on the cloud app.**
**Returns:** `{"backend": "molab_bridge", "config": {...}, "models": {"person": {"weights": "remote: person", "bridge": {...}, "last_detect": {...}}, "weapon": {...}, "fire": {...}, "faces": {...}}}`
**Notes:** Reports each model's connection status and recent timings separately, since one can be reachable while another is misconfigured. `bridge.connected: false` (or an `error` key) on any model means every call to it will **fail** rather than return an empty result — check here first when any feature reports an `error` state. Its absence on `features.main:app` is itself the answer for that app: which backend is running is a property of which app you launched, never of a config file that could disagree with reality.
