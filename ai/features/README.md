# The computer-vision service

A self-contained FastAPI service exposing ten CV/site features over one port, with an optional
cloud-offload variant. **This folder has no dependencies outside itself** — copy it into any
project, install the pip requirements, and run it.

Imports are relative throughout, so **the folder can be renamed as well as moved** — which means the
run command depends on where you put it and what you called it. Substitute the package path below
for this folder's own import path:

```bash
pip install -r <this-folder>/requirements.txt
uvicorn <package.path>.main:app --host 0.0.0.0 --port 8000        # local models
uvicorn <package.path>.cloud.main:app --host 0.0.0.0 --port 8000  # same routes, models on a molab GPU
```

| this folder lives at | run, from the parent of the top package |
|---|---|
| `features/` (the source repo) | `uvicorn features.main:app --port 8000` |
| `core/ai/` | `uvicorn core.ai.main:app --port 8000` |
| `cv_service/` | `uvicorn cv_service.main:app --port 8000` |

Only one of the two `uvicorn` commands runs at a time (same port, same routes) — which one you
launch is the whole choice; see `cloud/README.md` for what moves to the GPU and what stays local,
and why that's a launch-time choice rather than a config toggle. The cloud variant additionally
needs `molab_bridge/` (a sibling of `features/`, not inside it — see its own README) running and a
molab notebook attached; `pip install requests` is its one extra dependency (usually already
present transitively via `ultralytics`/`insightface`).

`GET /` lists every route; `/docs` is interactive OpenAPI. Full reference with payloads and
responses: `docs/api.md`, inside this folder — travels with it if you copy `features/` elsewhere.

## What's here

| folder | mounted at | what it does |
|---|---|---|
| `cameras/` | `/cameras` | the site camera table — define a camera once, tick which features watch it |
| `calibration/` | `/calibration` | pixel↔floor homography per camera, multi-camera alignment |
| `zoning/` | `/zoning` | headcount inside named floor polygons, pushed on change |
| `employee_activity/` | `/employee_activity` | present/away per workstation, built on `zoning`'s occupancy — no face recognition |
| `person_tracking/` | `/people` | live multi-camera person tracking — persistent IDs + floor positions |
| `face_recognition/` | `/face` | enroll + event-triggered `/face/scan` for gate access, `/face/capture` for anonymous visitors |
| `weapon_detection/` | `/weapon` | handguns, knives — continuous alert stream |
| `fire_detection/` | `/fire` | fire, smoke — continuous alert stream |
| `emotion_detection/` | `/emotion` | customer mood at a service desk |
| `wanted_detection/` | `/wanted` | alerts when a watchlisted person appears |
| `cloud/` | (same routes, + `/detector`) | drop-in cloud-offload variant — see its own README |

Each feature is exactly two files: `engine.py` (the CV, no web concepts) and `api.py` (an
`APIRouter`, no CV logic) — except `zoning`/`employee_activity` (`zones.py`/`tracker.py` in place of
`engine.py`, since neither runs its own model) and `cameras`/`calibration` (metadata/geometry, no
model at all). `main.py` mounts them all and owns the shared `/frame` and `/video_meta`.

`common/` holds the pieces more than one feature needs — the alert broadcaster, video reading,
and the shared person detector (`zoning` and `person_tracking` load the same checkpoint once
between them). Multi-camera fusion used to live here too; `zoning`'s world-mode zones now read
live positions from `person_tracking` instead of fusing independently — see
`features/zoning/api.py`'s docstring.

## First run

Model weights download automatically into this folder's `models/` (~55MB total):

| feature | source |
|---|---|
| weapon | Hugging Face, project-trained Sohas fine-tune |
| zoning / person_tracking | Hugging Face, project-trained person detector (shared — one in-process copy) |
| fire | GitHub release |
| face / emotion / wanted | InsightFace + hsemotion cache to `~/.insightface`, `~/.hsemotion` (library-managed, like pip's cache) |

All of it lands in `models/` **inside this package**, so a copied folder stays self-sufficient.

Everything the service **writes** goes to `data/` inside this package: `zones.json`, `site_calibration.json`,
and the two galleries. These locations are **fixed** — they do not depend on which directory you
launch from, so the service behaves identically under a shell, systemd, or Docker.

## Configuration

There are exactly three ways to configure this package, and environment variables are deliberately
not one of them:

**1. Fixed** — file locations (`paths.py`). Nothing to set. Paths that follow the working directory
are the classic way to half-configure a deployment without noticing: start the service in the wrong
place and it comes up with zero zones, serving happily, looking exactly like "nobody is in any zone".

**2. `config.json`** (in this folder) — values you set once for a site. It may be partial or absent; missing
keys fall back to built-in defaults, so a fresh copy runs unconfigured. Typos and wrong types are
reported at startup rather than silently ignored. `GET /config` shows what is actually in effect.

```json
{
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
              "diffusion_revive": false}
}
```

`detector.backend` picks the **runtime** for the shared person detector. The model is always the
same `yolo11m_multi.pt`; only what executes it changes. `auto` (the default) picks:

| condition | backend | measured, 2 cams @1280 |
|---|---|---|
| CUDA GPU present | pytorch on cuda | untested (no CUDA here) |
| Intel GPU present | openvino | **0.97 s** |
| ARM (Raspberry Pi) | ncnn | 3.92 s on x86 — right choice only on ARM |
| otherwise | pytorch on cpu | 2.52 s |

All backends produce identical boxes (verified at 640/1280/1920, IoU 0.97–1.00) — this is a
hardware-utilisation change, not an accuracy trade. Both accelerators are optional installs; a
missing one simply isn't selected, and the service says which it chose at startup. Pin the value
only to reproduce a problem — a hand-set backend is how a deployment ends up on the slow path
without anyone noticing.

Two values are measured rather than chosen and shouldn't be changed casually: `fire.imgsz` of 1280
(smoke scores roughly double what it does at 640) and `wanted.threshold` of 0.50 (an open-set
operating point — see `docs/live_alerts.md` for what it buys and what it can't promise).
`zoning.weights` set to a local `.pt` path skips the 40MB download.

`person_tracking`'s knobs mirror `architectures/pom_fusion/generic_pipeline.py`'s own CLI flags at
their validated defaults — every one of them is a multiple of the scene's own measured person-width,
not an absolute unit (see that module's constants block for the full derivation). It also needs
**≥2 cameras, calibrated *and* aligned** through `/calibration` before it will track anything —
`GET /people/status` reports `idle` until that's true, then `bootstrapping` (~30s on a live source,
recovering head homographies + person-width scale + room extent from real detections) before
`running`.

`cam_support_min` (default 2) requires that many cameras' evidence to agree before a floor position
is even considered a candidate detection — not a confidence discount, an outright exclusion
(`engine.py`'s `hybrid_detect`). With exactly 2 cameras, anywhere only ONE of them can see is a
tracking blind spot: no detection is ever produced there, existing tracks freeze and wait up to
`max_lost_s` to revive, and a person who spends the whole time there is never tracked at all. Lower
it to 1 to track single-camera-visible areas, at the cost of losing the cross-camera false-positive
suppression this default provides — a real accuracy tradeoff, not a free fix. `zoning` pixel-mode
zones are unaffected (single-camera by design, no fusion, no gate).

**3. An API call** — for what must change while running: `PUT /wanted/threshold` takes effect on the
next detection cycle. It is process-lifetime only, so `config.json` stays the durable default and a
restart returns to it.

## Two things to know before deploying

**There is no authentication.** Every endpoint is open to anyone who can reach the port. That is a
deliberate choice for an academic project, and it is not safe as-is:
`/wanted/alerts/stream` broadcasts the names of people flagged as wanted with a photo attached, and
`/face` and `/wanted` can both read out stored biometric embeddings. Put this behind an
authenticating reverse proxy with TLS before exposing it beyond a trusted LAN.

**The two gallery files are biometric data** tied to named real people —
`data/face_gallery.json` and `data/wanted_gallery.json`, alongside the zones and calibration this
service writes. They are gitignored in the source repo via `*_gallery.json` (and the whole `data/`
directory) — **keep an equivalent rule if you copy this folder into another repo**, or the first
`git add -A` commits real people's face embeddings permanently.
