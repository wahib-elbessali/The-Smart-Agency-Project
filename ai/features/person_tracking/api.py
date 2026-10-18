"""Deployable surface over engine.py, mounted at /people. Continuous person
tracking across every registered, calibrated, ALIGNED camera -- identities +
live floor positions, not headcount (see features/zoning for that). Unlike
every other feature here, this one has a real one-time SETUP cost (recovering
head homographies, person_scale and room extent -- ~30s wall-clock on a live
source, effectively instant on file sources) before it can track anything;
the background loop below manages that as an explicit state machine (idle ->
bootstrapping -> running / error) instead of assuming every cycle looks like
every other, the way zoning's per-cycle detection can.

- GET       /people/sources             -- current camera registry + which
                                            cameras are calibrated/aligned.
- POST      /people/sources             -- {"sources": {cam: url_or_path}},
                                            merges (accumulates across calls,
                                            same convention as zoning/weapon).
                                            Adding/removing a camera changes
                                            the SET this scene was bootstrapped
                                            for, so it invalidates any current
                                            bootstrap and re-triggers one.
- DELETE    /people/sources/{camera}    -- stops watching one camera; same
                                            invalidation as above.
- GET       /people/status              -- {phase, sources_known, calibrated,
                                            aligned, person_scale, room, fps,
                                            warnings, error, active_tracks}.
- WebSocket /people/tracks/stream       -- snapshot on connect, a "state"
                                            message on every phase transition,
                                            and a "tracks" message every cycle
                                            once running (the FULL confirmed-
                                            track snapshot each time, not
                                            diffed the way zoning diffs
                                            occupancy counts -- a moving
                                            person's position changes almost
                                            every cycle by construction, so a
                                            diff would suppress almost nothing
                                            while adding a float-jitter bug
                                            surface; update_interval already
                                            bounds the broadcast rate).

Bootstrap triggers AUTOMATICALLY once >=2 registered cameras are all
calibrated AND aligned (mirrors zoning's "runs once zone+source exist"
philosophy, and every other feature here starting its background work once
its own minimal precondition exists) -- there is deliberately no POST
/people/start; GET /people/status gives the observability an explicit
endpoint's response would have given anyway.

Gates (entry/exit points, an accuracy lever for low-quality/low-res footage
where detection noise is a bigger problem than it is on HD -- an unmatched
detection far from every marked gate is assumed to be an existing person
whose position estimate drifted, not someone genuinely new) are read fresh
from features/calibration's GATES file at every bootstrap, via
POST/DELETE /calibration/gates. No gates marked yet -> load_gates returns
[], and every gate-dependent branch in engine.Tracker.step is guarded by
`if gates:`/`if gates and ...`, so that degrades safely to "prior disabled,"
never an error.

The camera registry/calibration is read fresh every bootstrap (from
features/data/site_calibration.json, via features/calibration -- no changes
needed there, its output already matches the schema this engine reads).
person_scale/room/Hh are NOT persisted across a process restart -- a stale
scene geometry silently corrupting every downstream person-width threshold is
exactly the failure class this design exists to prevent, so a restart always
re-bootstraps fresh.

Tunables live in features/config.json under "person_tracking" -- see
config.py. The person detector (yolo11m_multi.pt) is shared with
features/zoning via common/person_detector.py -- one in-process model copy,
not two.
"""
import asyncio
import itertools
from contextlib import asynccontextmanager

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..common.video_source import read_frame
from ..common import cameras as registry
from ..common.cameras import quality as camera_quality
from ..common.person_detector import get_model
from ..calibration.engine import load_calibration
from ..config import CONFIG
from ..paths import CALIBRATION, GATES
from .engine import Tracker, bootstrap_site, build_tracker_params, detect_imgsz, load_gates

_CFG = CONFIG["person_tracking"]
WEIGHTS = _CFG["weights"]   # restart-only; conf and update_interval are read live from _CFG

# Cameras come from the site table (common/cameras.py), not a private dict:
# one description per camera, and it survives a restart. Before this, six
# features each held their own list in memory and a restart came back up
# watching nothing -- which looks exactly like "the room is empty".

_state = {"phase": "idle", "warnings": [], "error": None, "person_scale": None,
          "room": None, "fps": None, "cams_bootstrapped": None, "gates_loaded": None}
_scene = None                 # bootstrap_site()'s return dict, once running
_tracker = None               # Tracker instance, once running
_frame_ctr = itertools.count(1)
_ws_clients = set()


def _cam_status():
    cams = sorted(registry.for_feature("people"))
    cal = load_calibration(CALIBRATION)
    calibrated = [c for c in cams if c in cal]
    aligned = [c for c in calibrated if cal[c].get("diag", {}).get("aligned")]
    return cams, calibrated, aligned


def request_rebootstrap():
    """Drop the current scene/tracker so the background loop rebuilds them.

    Called when something the bootstrap MEASURED has changed underneath it
    -- today only a camera's quality (frame size), since the head
    homographies are fitted in pixels and do not survive a resize. Costs
    every track id, which is why nothing calls this speculatively."""
    global _scene, _tracker
    _state.update(phase="idle", error=None)
    _scene = None
    _tracker = None


def _track_dicts():
    return [{"id": t.did, "x": round(float(t.pos[0]), 2), "y": round(float(t.pos[1]), 2),
             "hits": t.hits, "misses": t.misses} for t in _tracker.active_tracks()]


def get_active_tracks():
    """-> [{"id","x","y","hits","misses"}, ...] the CURRENT confirmed tracks,
    or None if this feature isn't running (idle/bootstrapping/error) --
    NOT the same as an empty list, which means "running, genuinely nobody
    there". Callers (features/zoning/api.py, for world-mode zones -- see
    that module's docstring for why zoning stopped running its own
    detection) must not conflate the two, the same silent-zero trap this
    project keeps guarding against elsewhere (e.g. zoning's own `camera`-
    must-be-in-`sources` check). A plain in-process function call, not a
    network request -- both features run in the same app/process."""
    if _tracker is None:
        return None
    return _track_dicts()


def _run_tracking_cycle(sources_snapshot, cams):
    """Synchronous, CPU-bound -- ONE live frame per camera, one batched YOLO
    call across all of them (same batching make_cache used in the batch
    pipeline), fused via this scene's hybrid_detect, stepped through the
    Tracker. Run inside asyncio.to_thread() by the background loop so it
    never blocks the event loop/WebSocket traffic while YOLO is working."""
    frames = {c: read_frame(sources_snapshot[c], quality=camera_quality(c))
              for c in cams}
    live_cams = [c for c in cams if frames.get(c) is not None]
    boxes = {}
    if live_cams:
        model = get_model(WEIGHTS)
        imgsz = detect_imgsz(_scene["img_dims"])
        results = model([frames[c] for c in live_cams], imgsz=imgsz, conf=_CFG["conf"], verbose=False)
        for c, r in zip(live_cams, results):
            b = r.boxes
            boxes[c] = (b.xyxy.cpu().numpy() if b is not None and len(b) else np.zeros((0, 4)))
    for c in cams:                          # hybrid_detect needs an entry for EVERY cam it was built with
        boxes.setdefault(c, np.zeros((0, 4)))
    dets = _scene["hybrid_detect"](boxes)
    _tracker.step(next(_frame_ctr), dets)
    # The per-camera boxes go out with the tracks: this cycle already has
    # them, and without them nothing downstream can draw a detection over a
    # camera image (the tracks themselves are WORLD positions). Pixel
    # coordinates here are in the QUALITY-SCALED frame -- the same space
    # GET /frame?camera= returns, so an overlay lines up by construction.
    px = {c: [[round(float(v), 1) for v in b] for b in boxes[c]] for c in boxes}
    return _track_dicts(), px


async def _broadcast(msg):
    dead = []
    for ws in list(_ws_clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


async def _background_loop():
    global _scene, _tracker
    while True:
        cams, calibrated, aligned = _cam_status()
        ready = len(cams) >= 2 and set(cams) <= set(aligned)

        if _state["phase"] in ("idle", "error") and ready:
            _state["phase"] = "bootstrapping"
            await _broadcast({"type": "state", **_state})
            sources_snapshot = registry.for_feature("people")
            try:
                scene = await asyncio.to_thread(
                    bootstrap_site, sources_snapshot, CALIBRATION, cams,
                    room_trim_pct=_CFG["room_trim_pct"], foot_sigma_pw=_CFG["foot_sigma_pw"],
                    cam_support_min=_CFG["cam_support_min"], peak_min=_CFG["peak_min"],
                    weights_override=WEIGHTS)
                _scene = scene
                P = build_tracker_params(scene["person_scale"], scene["fps"],
                                         gate_pw=_CFG["gate_pw"], revive_pw=_CFG["revive_pw"],
                                         dup_guard_pw=_CFG["dup_guard_pw"], max_lost_s=_CFG["max_lost_s"],
                                         stale_gate_s=_CFG["stale_gate_s"],
                                         diffusion_revive=_CFG["diffusion_revive"])
                gates = load_gates(GATES)
                _tracker = Tracker(gates=gates, P=P)
                _state.update(phase="running", warnings=scene["warnings"], error=None,
                              person_scale=scene["person_scale"], room=scene["room"],
                              fps=scene["fps"], cams_bootstrapped=cams, gates_loaded=len(gates))
            except Exception as e:
                _state.update(phase="error", error=str(e))
            await _broadcast({"type": "state", **_state})
        elif _state["phase"] == "running" and set(cams) != set(_state["cams_bootstrapped"] or []):
            # the registered camera set changed since this bootstrap -- it no
            # longer describes what's actually being watched, so start over.
            _state.update(phase="idle", error=None)
            _scene = None; _tracker = None
            await _broadcast({"type": "state", **_state})
        elif _state["phase"] == "running":
            sources_snapshot = registry.for_feature("people")
            try:
                tracks, px = await asyncio.to_thread(
                    _run_tracking_cycle, sources_snapshot, cams)
                await _broadcast({"type": "tracks", "tracks": tracks, "boxes": px})
            except Exception as e:
                print(f"[person_tracking.api] tracking cycle failed: {e}")
        await asyncio.sleep(_CFG["update_interval"])


@asynccontextmanager
async def lifespan():
    task = asyncio.create_task(_background_loop())
    yield
    task.cancel()


router = APIRouter(prefix="/people", tags=["person tracking"])


class SourcesRequest(BaseModel):
    sources: dict[str, str]


@router.get("/sources")
def get_sources():
    cams, calibrated, aligned = _cam_status()
    return {"sources_known": cams, "calibrated": calibrated, "aligned": aligned}


@router.post("/sources")
def post_sources(req: SourcesRequest):
    # Writes through to the site camera table rather than a private dict,
    # so the assignment survives a restart and one camera is described in
    # one place. Kept as an endpoint because it is the shape existing
    # clients already speak; /cameras is the fuller interface.
    for cam, url in req.sources.items():
        registry.upsert(cam, url=url)
        registry.assign(cam, "people", True)
    cams, calibrated, aligned = _cam_status()
    warnings = []
    if len(cams) < 2:
        warnings.append("need >=2 registered cameras for cross-camera tracking")
    uncal = sorted(set(cams) - set(aligned))
    if uncal:
        warnings.append(f"camera(s) {uncal} not yet calibrated+aligned "
                        f"(POST /calibration/rect, then /calibration/align)")
    return {"sources_known": cams, "calibrated": calibrated, "aligned": aligned, "warnings": warnings}


@router.delete("/sources/{camera}")
def delete_source(camera: str):
    """Stops /people watching this camera. The camera stays in the table
    for other features -- use DELETE /cameras/{id} to remove it entirely."""
    registry.assign(camera, "people", False)
    return {"camera": camera, "deleted": True}


@router.get("/status")
def get_status():
    return {**_state, "active_tracks": len(_tracker.active_tracks()) if _tracker is not None else None}


@router.websocket("/tracks/stream")
async def tracks_stream(ws: WebSocket):
    """Server push only: connect and immediately get a `{"type":"snapshot",
    "state", "tracks"}` message with current phase and tracks (if running),
    then a `{"type":"state",...}` message on every phase transition and a
    `{"type":"tracks","tracks":[...],"boxes":{cam:[[x1,y1,x2,y2],...]}}`
    message every cycle once running. `tracks` are WORLD positions; `boxes`
    are pixel coordinates in the quality-scaled frame, i.e. the same space
    GET /frame?camera= returns, so an overlay lines up without rescaling. The
    background tracking loop keeps running regardless of whether anyone is
    connected."""
    await ws.accept()
    _ws_clients.add(ws)
    try:
        snapshot = {"type": "snapshot", "state": _state["phase"],
                   "tracks": _track_dicts() if _tracker is not None else []}
        await ws.send_json(snapshot)
        while True:
            # bare receive() returns a dict and does NOT raise on disconnect --
            # only receive_text()/receive_json() do that. Must check the type
            # and break manually.
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)
