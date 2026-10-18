# molab GPU bridge

Runs every model this project uses -- person, weapon, fire, and InsightFace's face detector+embedder
-- on a cloud GPU (a [molab](https://molab.marimo.io) notebook) instead of locally, while every
piece of STATE -- calibration, POM fusion, the tracker, track identities, zones, gates, the face
galleries -- stays on the local machine. See molab_notebook.py's docstring for exactly what does and
doesn't move, and why emotion classification and gallery matching are the two deliberate holdouts.

Adapted from the working bridge at `Documents/Random/molab`. The protocol, the tunnel choice and the
keepalive workaround come from there; the multi-camera bundling, the request/response shape and the
coordinate handling are specific to this project and are where it deviates. Both deviations are
explained below, because both were deliberate.

**Nothing in `features/`'s other modules or `architectures/` imports any of this.** Local models are
untouched and remain the default everywhere. `features/cloud/` is the seam that adopts the bridge --
see its own README for the four hooks that wire it in. `features/cloud/protocol.py` and
`features/cloud/remote_detector.py` are vendored copies of this directory's `protocol.py` and
`remote_detector.py` (see those files' own docstrings) -- `features/` is meant to be copied as one
standalone folder into another project, so its cloud-capable variant can't reach outside itself for
the wire format either. Port any protocol change to both copies.

---

## Why

Measured on the dev laptop (i7-1165G7, no CUDA), 4 cameras at 1920×1080, the deployed
`yolo11m_multi.pt`:

| stage | time | share of cycle |
|---|---|---|
| **detector** (PyTorch CPU) | **12.72 s** | **99.7 %** |
| POM fusion (`hybrid_detect`, GRID_N=240) | 0.036 s | 0.3 % |
| `Tracker.step` | 0.0001 s | ~0 |

Against `person_tracking.update_interval` of 0.5 s that is **25× too slow**. The detector is
effectively the entire cost of a cycle, so replacing just the detector replaces just about all of it
— and everything that holds state stays put.

For reference, the local alternatives measured on the same frames:

| | 4 cams @ 1920 | vs 0.5 s | vs 2.0 s |
|---|---|---|---|
| PyTorch CPU (today) | 12.72 s | 25× short | 6× short |
| OpenVINO CPU FP16 | 12.40 s | — | — |
| **OpenVINO iGPU FP16** | **5.66 s** | 11× short | 3× short |
| OpenVINO iGPU INT8 | *not measured* | — | — |

OpenVINO on the iGPU is a real 2.25× for one line of export and no accuracy cost (median IoU
0.97–1.00 vs PyTorch, identical box counts) — **worth doing regardless of this bridge**, as the
local fallback. It just does not close a 25× gap on its own.

---

## Running it

```bash
pip install fastapi uvicorn requests websockets opencv-python numpy      # local side
python molab_bridge/bridge_server.py                                    # prints a tunnel URL
```

Then open `molab_notebook.py` in molab with a GPU attached, paste the printed URL into
`TUNNEL_URL`, and run all cells. `GET http://127.0.0.1:8100/status` shows whether a notebook is
connected and the recent round-trip timings.

ngrok needs a one-time setup (free account): `winget install --id Ngrok.Ngrok -e`, then
`ngrok config add-authtoken <token>`. Without it the bridge still serves on
`ws://127.0.0.1:8100/ws`, which is all the smoke test needs.

### Testing it without molab

```bash
python molab_bridge/smoke_test.py                       # quick, imgsz 640
python molab_bridge/smoke_test.py --imgsz 1920          # full HD (slow on CPU)
python molab_bridge/smoke_test.py --imgsz 1280 --max-width 1280   # exercises the rescale path
```

Runs the real bridge with a stand-in notebook backed by the local detector, and reports two separate
things — how faithfully the bridge transmits, and what the transmit settings cost in accuracy.
Conflating those is how you end up debugging a bridge that was never broken.

Current result on 4 cameras of Warehouse_027: **identical box counts, median IoU 1.000**, both at
native resolution and with `--max-width 1280`.

---

## Files

| file | side | what it is |
|---|---|---|
| `protocol.py` | both | the wire format, and the coordinate rescale |
| `bridge_server.py` | local | owns the tunnel, relays bundles, `/detect` + `/status` |
| `remote_detector.py` | local | `RemoteDetector` (person/weapon/fire) + `RemoteFaceDetector` |
| `molab_notebook.py` | molab | stateless: every model, routed by the bundle's `model` field |
| `smoke_test.py` | local | end-to-end test, no GPU or network needed |

---

## The three design decisions

**1. All cameras go up in ONE message, sharing one capture timestamp.** POM fusion sums evidence
from every camera onto a single floor grid, so cameras that disagree about *when* fuse into people
who were never there. Running N independent bridges would reintroduce exactly the per-camera drift
already diagnosed the hard way on the live-streaming path (`docs/tracking_attempts.md`, "The
live-streaming era"). Bundling makes that failure structurally impossible — there is only one
timestamp to be wrong about.

**2. Request/response, not the template's 30-deep pipeline.** The upstream bridge pipelines hard
because it chases 60 fps and its ceiling is `MAX_IN_FLIGHT / RTT`. `/people` runs at ~2 fps while
`1/RTT` on a ~100 ms link is ~10 fps, so pipelining buys nothing we can use — and it costs the
property we want most: that the boxes a cycle acts on belong to the frames that cycle captured. This
is the same credit system with `MAX_IN_FLIGHT = 1`, which is what the template's own formula
recommends at our target rate. Revisit it only if `update_interval` ever drops near the link's RTT.

**3. The notebook is stateless — no tracker, no ReID, no track buffer.** molab sessions get
reclaimed and the runtime restarts; anything with memory up there would be destroyed on reconnect.
For `/people` that memory *is* the feature — persistent identities — so a dropped session must cost
a few cycles of detection, not a roomful of identities. (The upstream bridge does run BoT-SORT in
the notebook, because it had no local state to protect. We do.)

---

## Failure modes, and what they look like

**Never a silent zero.** If the notebook is gone, `detect()` raises; the bridge returns 503. It does
not return "no boxes", because an empty result is a *claim that the room is empty* — the failure
mode this project guards against everywhere else (`features/zoning`'s `people_tracking_ready` flag
exists for the same reason). Wired into `/people`, a dead tunnel surfaces as its structured `error`
phase.

**Stale answers are discarded, not applied.** After a timeout the slow reply eventually arrives;
matching on `seq` means it is dropped rather than handed to whichever cycle is waiting now.

**The coordinate rescale is the quietest way this breaks.** Downscale for bandwidth, forget to undo
it, and every box is well-formed, plausible, and at 0.67× of where the person is. Nothing raises.
The ground homography maps it confidently to the wrong place, and it presents as a calibration
fault — a diagnosis this project has already been sent down twice by other causes. The local side
owns the rescale (it chose the scale), and `smoke_test.py --max-width` asserts it.

---

## Bandwidth

Measured, one 1920×1080 frame from Warehouse_027, 4 cameras:

| quality | 1920px | 1280px | 960px |
|---|---|---|---|
| q40 | 9.2 Mbit/s | 5.0 | 3.3 |
| q75 | 15.1 Mbit/s | 8.4 | 5.5 |
| q90 | 25.0 Mbit/s | 13.8 | 9.0 |

…at `update_interval` 0.5 s (2 cycles/s). **Divide by 4** at the 2.0 s default, which is the cheapest
way to fit a home upload link: q75 at native HD drops from 15.1 to 3.8 Mbit/s.

The tension to respect: the bridge's speed comes from compressing, while this project's single
biggest detector win came from running at **native** resolution (recall 20 % → 66 % on HD). On one
frame set, q75 at native cost nothing and `--max-width 1280` cost nothing either — but that is one
frame set of a mostly-empty warehouse. **Measure recall over a real sequence at whatever settings you
intend to run**, the same way the resolution finding itself was established.

---

## Wiring it in

Done, in `features/cloud/` -- a subpackage of `features/` that installs remote hooks and serves
`features/`'s own app, so local models stay the default and the cloud path is an explicit, separate
launch (`uvicorn features.cloud.main:app`), not a config toggle. See its README for the four hooks
and `parity_test.py` for the correctness proof (person/weapon/fire boxes, face identification
outcome) against a stand-in notebook, no GPU required.

`features/`'s other modules still may not import from outside `features/` -- the hooks live in
`features/cloud/`, which does the importing, exactly like `common/person_detector.py`'s original
`set_model_factory` seam.

---

## Before pointing this at a real site

This streams live footage of people off-premises, through a public URL, to a service with no
authentication, and the bridge itself has none either. That is consistent with the rest of this
project (see `features/main.py`'s docstring) and it is fine for a demo or dev work.

It is not fine for a deployment, and `/face` and `/wanted` raise the stakes further, since those
handle biometric data. Real use needs a persistent GPU endpoint rather than an ephemeral notebook,
auth on both ends, and TLS that terminates somewhere you control.
