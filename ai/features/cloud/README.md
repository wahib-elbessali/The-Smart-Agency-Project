# features/cloud — the same service, models on a cloud GPU

Same endpoints, same payloads, same responses as [`features/`](..). The only difference is
where the models run — **every** model: person, weapon, fire, and face detection+embedding (which
`/emotion` and `/wanted` also depend on).

```bash
uvicorn features.main:app        --port 8000     # local models  (unchanged)
uvicorn features.cloud.main:app  --port 8000     # remote models, identical API
```

Pick one at launch. A consumer of the API cannot tell them apart, which is the point — the backend
and frontend never change.

The cloud one needs the bridge running and a molab notebook attached:

```bash
python molab_bridge/bridge_server.py     # prints a tunnel URL for the notebook
```

---

## Why this is a subpackage of `features/`, not a copy of it

The obvious build is: duplicate the folder, change one file. It's also how the two drift — every
future fix has to be found and applied twice, and nothing fails when someone forgets one.

So `features/cloud/` **is not a copy**. It reimplements no endpoint. It installs a different
detector backend and then serves `features/`'s own app object, so the routes are literally the same
objects, and parity is guaranteed by construction rather than by discipline.

The changes inside `features/`'s other modules are additive, and follow one pattern used four times:
`common/person_detector.py`, `weapon_detection/engine.py` and `fire_detection/engine.py` each gained
a `set_model_factory()` hook; `face_recognition/engine.py` gained `set_faces_override()` (a plain
function swap, since InsightFace's result isn't a model object to replace, just a call to redirect).
Every hook defaults to the local loader. With none installed, behaviour is exactly what it always
was — verified in `parity_test.py`. Every module outside this one still imports nothing from outside
`features/` and does not know `features/cloud/` exists; only this subpackage's own `main.py` reaches
up to install the hooks before serving the shared app object.

`features/cloud/` DOES live inside `features/`, unlike the two things it depends on for the wire
protocol (`protocol.py`, `remote_detector.py`, vendored copies of `molab_bridge/`'s originals — see
those files' own docstrings for why copies rather than a shared import). That's deliberate: the
whole `features/` folder, cloud capability included, is meant to be copied as ONE unit into another
project — see `features/paths.py`'s docstring. `molab_bridge/` is a
separate deployable (it runs on a different machine — the molab GPU notebook side, plus a local
relay process) and is never bundled with this folder.

---

## What moves, and what doesn't

**Moves:** every model this project runs. `yolo11m_multi.pt` (shared by `/zoning` and `/people`),
the weapon and fire fine-tunes, and InsightFace's detector+embedder (shared by `/face`, `/emotion`,
`/wanted`). The first of those is
99.7 % of a tracking cycle (12.72 s of 12.76 s, 4 cameras at 1920×1080, measured on the dev laptop).

**Stays local, always:** POM fusion, the tracker and every track identity, calibration, gates,
zones. Two more things stay local *deliberately*, not because they're too small to bother with:

- **hsemotion** (emotion classification, ~16 MB) — it runs on a face crop the local process already
  has once InsightFace has found a face; a network round trip for it buys nothing.
- **Gallery matching** (`identify()`, in `/face` and `/wanted`) — comparing an embedding against
  NAMED real people's stored data must never touch the network. Only the embedding *extraction*
  moves; the comparison against biometric identities never does.

That split isn't only about compute. molab sessions get reclaimed; anything stateful up there dies on
reconnect, and for `/people` the state *is* the feature. A dropped session costs a few cycles of
detection, never a roomful of identities or a leaked gallery.

---

## Files

| file | what it is |
|---|---|
| `main.py` | installs every hook, serves `features/`'s app, adds `GET /detector` |
| `remote_model.py` | `RemoteYOLO` (person/weapon/fire, ultralytics-shaped) + `remote_detect_faces` |
| `protocol.py` | vendored copy of `molab_bridge/protocol.py` — the wire format |
| `remote_detector.py` | vendored copy of `molab_bridge/remote_detector.py` — `RemoteDetector` + `RemoteFaceDetector` |
| `config.json` | bridge URL and transmit settings |
| `parity_test.py` | route parity, backend selection, and 4 correctness checks (person/weapon/fire/faces) |

---

## `GET /detector`

The one route this app adds. It reports each MODEL's status separately (`person`, `weapon`, `fire`,
`faces`) — whether its notebook connection is live and recent timings — since one can be reachable
while another is misconfigured.

Its absence on `features/` is itself the answer for that app — **which backend is running is a
property of which app you launched**, never of a config file that could disagree with reality.

`bridge.connected: false` means every detection will **fail** rather than return an empty room.
Check here first when `/people` reports `error`.

---

## Failure semantics

This package shares the local detector's *interface* and deliberately does **not** share its failure
behaviour.

A model that returns no boxes (or no faces) is making a positive claim that the frame had nothing
in it. When the tunnel is down, that claim is false, and the whole service is built to never say it
— the same rule behind `features/zoning`'s `people_tracking_ready` flag. So every failure path
raises and nothing catches: a dead tunnel surfaces as the calling feature's own error state, exactly
like a dead camera.

Verified: with no bridge reachable, a detection call raises `ConnectionError`. A local `weights`
override is refused outright rather than silently ignored, since the remote side loads its own copy.

---

## Testing

```bash
python features/cloud/parity_test.py
```

Six checks: route parity (51 shared routes + `/detector`), that every hook resolves to a remote
backend and clears back to local, and four correctness checks against a real bridge with a stand-in
notebook — no GPU and no network required:

- **person / weapon / fire**: identical box counts, IoU > 0.99, AND matching class labels (weapon
  and fire actually use the class — pistol vs knife, fire vs smoke — where person doesn't).
- **faces**: NOT bytewise embedding equality (JPEG changes the input, so the two embeddings are
  never bit-identical) — the bar is *identification outcome*: does the remote embedding match the
  same enrolled person `identify()` finds locally? Measured: cosine similarity 0.983 between the
  local and remote embeddings of the same face, both identifying correctly.

Current result: **all six checks pass**.

Note the box-detection reference is the local model run on *the same JPEG bytes, at the same
CLAMPED resolution* the cloud path actually used (`RemoteDetector` shrinks a requested imgsz down to
whatever was really transmitted) — not on raw frames, and not at the naively-requested imgsz. Both
of those are different questions from "does the bridge transmit faithfully", and comparing against
either makes a perfectly faithful bridge look broken: raw-frame comparison confuses "faithful" with
"what compression costs" (measured separately in `molab_bridge/smoke_test.py`); naive-imgsz
comparison is what caused fire's very first test run to report a false failure here, since 1280 gets
silently clamped to 960 once `max_width=960` is applied.

Run it after touching `features/` (including `features/cloud/`) or `molab_bridge/`.

---

## Configuration

`config.json`:

| key | default | notes |
|---|---|---|
| `bridge_url` | `http://127.0.0.1:8100` | where `bridge_server.py` is listening |
| `jpeg_quality` | 75 | |
| `max_width` | `null` | `null` = native resolution |
| `timeout` | 35.0 s | per detection call |

`max_width` is the main bandwidth lever and it is **not** free: this project's largest detector win
came from running at native resolution (HD recall 20 % → 66 %). At `update_interval` 0.5 s, four HD
cameras at q75 need ~15 Mbit/s upload; the 2.0 s default quarters that to ~3.8. See
[`molab_bridge/README.md`](../../molab_bridge/README.md) for the full table, and measure recall over
a real sequence before trusting any setting — one frame proves nothing.

---

## Before real use

Same standing warning as the rest of the project, with one addition specific to this package: it
streams live footage of people off-premises through a public tunnel to a service with no
authentication, and the bridge has none either. Fine for a demo. Not fine for a deployment,
especially alongside `/face` and `/wanted`, which handle biometric data.
