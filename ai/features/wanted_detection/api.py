"""Deployable surface over engine.py, mounted at /wanted by the unified app in
main.py. Continuous, always-on watchlist monitoring across whatever cameras are
registered -- same shape as weapon/fire/emotion detection, all built on
features/common/live_alert_service.py.

- POST      /wanted/watchlist          -- multipart name + photo, adds to the watchlist.
- GET       /wanted/watchlist           -- names + embedding counts. ?include_embeddings=true
                                           for the raw vectors (opt-in: dumping a wanted
                                           list's biometrics should be a deliberate act).
- DELETE    /wanted/watchlist/{name}    -- removes a person's ENTIRE watchlist entry.
- GET/PUT   /wanted/threshold           -- read / change the match threshold at runtime,
                                           effective on the next detection cycle, no restart.
- POST/GET  /wanted/sources, DELETE /wanted/sources/{camera}
- WebSocket /wanted/alerts/stream       -- pushed only when a camera's set of matched
                                           watchlist names changes.

THE ROUTES ARE DELIBERATELY NAMED DIFFERENTLY from features/face_recognition's
/enroll and /faces, even though the underlying gallery machinery is identical.
The catastrophic operator error this feature is shaped around is enrolling
someone into the WRONG list -- and `POST /face/enroll` vs `POST /wanted/watchlist`
cannot be confused for one another the way two identically-named routes could.
The galleries remain separate FILES too (wanted_gallery.json vs
face_gallery.json), so a delete on one provably cannot touch the other; note
that now the two run in ONE process, that file separation and the distinct route
names are the whole of the isolation -- there is no longer a process or port
boundary between them.

Tunables live in features/config.json under "wanted": threshold, min_face_px,
det_size, update_interval, confirm_cycles, hold_cycles. The threshold can also
be changed at RUNTIME via PUT /wanted/threshold, which takes effect on the next
detection cycle; that change is process-lifetime only, so config.json stays the
durable default. The watchlist itself is stored at a fixed location under
features/data/ -- see paths.py.
"""
import os
import re
import threading
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket
from pydantic import BaseModel

from ..common.live_alert_service import LiveAlertService
from ..face_recognition.engine import enroll, get_engine, load_gallery, save_gallery
from ..config import CONFIG, add_validator, on_change
from ..paths import WANTED_GALLERY
from .engine import THRESHOLD_FLOOR, detect_wanted_with_snapshot

_CFG = CONFIG["wanted"]
GALLERY_PATH = WANTED_GALLERY
DET_SIZE = _CFG["det_size"]   # restart-only: the shared face engine is prepared once at this size
# Defaults chosen for this feature specifically -- see features/common/live_alert_service.py's
# _apply_hysteresis. A late all-clear is harmless; a flapping accusation is not.
CONFIRM_CYCLES = _CFG["confirm_cycles"]   # startup values; PATCH /config updates the service itself
HOLD_CYCLES = _CFG["hold_cycles"]

# Operator-supplied names end up in a URL path (DELETE /watchlist/{name}), so a
# name containing "/" would be unroutable and undeletable forever. Rejecting the
# characters up front is simpler than escaping everywhere downstream.
_NAME_RE = re.compile(r"^[A-Za-z0-9 ._+-]{1,80}$")

_watchlist = load_gallery(GALLERY_PATH)
_config = {"threshold": _CFG["threshold"], "min_face_px": _CFG["min_face_px"]}
_startup_config = dict(_config)
# One lock over BOTH the watchlist and the config, so every detection cycle sees a
# consistent (watchlist, threshold) pair -- that makes "the change took effect on
# cycle N" an exact statement rather than a probabilistic one.
_state_lock = threading.Lock()


def _save_watchlist():
    """Atomic replace. save_gallery() truncates its target before writing, so a
    crash or full disk mid-write would leave a corrupt file and lose the entire
    watchlist -- and load_gallery() would then raise at import. Writing to a temp
    file and os.replace()ing it is atomic on both Windows and POSIX. Done here
    rather than by fixing save_gallery() so features/face_recognition stays out
    of the blast radius."""
    GALLERY_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = GALLERY_PATH.with_suffix(".json.tmp")
    save_gallery(_watchlist, tmp)
    os.replace(tmp, GALLERY_PATH)


def _detect(frame):
    """Runs in LiveAlertService's worker thread (asyncio.to_thread), concurrently
    with FastAPI's threadpool serving enroll/delete/threshold routes -- so the
    lock is load-bearing, not decorative.

    Reads the mutable state at CALL time, which is the whole mechanism behind the
    runtime-changeable threshold: LiveAlertService captured this closure once at
    construction, but the values it reads are looked up fresh every cycle."""
    with _state_lock:
        # The inner lists are copied too, not just the dict. A shallow dict copy
        # guards against a name being added/removed mid-iteration, but enroll()
        # does gallery.setdefault(name, []).append(...) -- mutating a list the
        # shallow copy still aliases, while identify() is iterating it. That's a
        # silent torn read rather than a crash, and this loop runs forever.
        watchlist = {name: list(embs) for name, embs in _watchlist.items()}
        threshold = _config["threshold"]
        min_face_px = _config["min_face_px"]
    # Inference happens OUTSIDE the lock, so an enroll request never waits behind
    # a detection cycle.
    return detect_wanted_with_snapshot(frame, watchlist, threshold,
                                       det_size=(DET_SIZE, DET_SIZE),
                                       min_face_px=min_face_px)


service = LiveAlertService(feature_key='wanted', detect_fn=_detect, update_interval=_CFG["update_interval"],
                           confirm_cycles=CONFIRM_CYCLES, hold_cycles=HOLD_CYCLES)


def _set_wanted(key):
    def apply(value):
        with _state_lock:
            _config[key] = value
    return apply


def _threshold_error(value):
    # Same floor PUT /wanted/threshold enforces: at or below the access-control
    # validated 0.248 this feature accuses people routinely (see engine.py).
    if not (THRESHOLD_FLOOR <= value <= 1.0):
        return f"wanted.threshold must be in [{THRESHOLD_FLOOR}, 1.0] -- below that, open-set matching false-alarms constantly"


# PATCH /config reaches the same state PUT /wanted/threshold does.
add_validator("wanted", "threshold", _threshold_error)
on_change("wanted", "threshold", lambda v: _set_wanted("threshold")(float(v)))
on_change("wanted", "min_face_px", lambda v: _set_wanted("min_face_px")(int(v)))
on_change("wanted", "update_interval", lambda v: setattr(service, "update_interval", v))
on_change("wanted", "confirm_cycles", lambda v: setattr(service, "confirm_cycles", v))
on_change("wanted", "hold_cycles", lambda v: setattr(service, "hold_cycles", v))

router = APIRouter(prefix="/wanted", tags=["wanted detection"])


@asynccontextmanager
async def lifespan():
    # Warm the InsightFace singleton before anything can race for it. get_engine()
    # in features/face_recognition/engine.py is an unguarded lazy singleton, and
    # several things can now hit it concurrently: this feature's background loop,
    # its enroll route, emotion detection's loop, and face_recognition's /scan --
    # all in ONE process since the APIs were unified, so two of them could see
    # _ENGINE is None and double-load the ~120MB pack. Warming here removes both
    # the race and the first-cycle latency spike. (Sharing that single instance
    # across three features is the main memory win of the unified app: it used to
    # be loaded once per process, three times over.)
    get_engine((DET_SIZE, DET_SIZE))
    await service.start()
    yield
    await service.stop()


def _decode_image(raw_bytes):
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@router.post("/watchlist")
def add_to_watchlist(name: str = Form(...), image: UploadFile = File(...)):
    """multipart/form-data: name (str) + image (one photo, exactly one face).
    -> {"name": ..., "embeddings_count": N} counting every photo ever added for
    this name."""
    name = name.strip()
    if not _NAME_RE.match(name):
        raise HTTPException(422, "name must be 1-80 chars of letters, digits, space, . _ + or -")
    img = _decode_image(image.file.read())
    if img is None:
        raise HTTPException(400, "could not decode image")
    with _state_lock:
        try:
            enroll(_watchlist, name, img)
        except ValueError as e:
            raise HTTPException(422, str(e))
        _save_watchlist()
        count = len(_watchlist[name])
    return {"name": name, "embeddings_count": count}


@router.get("/watchlist")
def list_watchlist(include_embeddings: bool = False):
    with _state_lock:
        if include_embeddings:
            return [{"name": n, "embeddings_count": len(e), "embeddings": [v.tolist() for v in e]}
                    for n, e in _watchlist.items()]
        return [{"name": n, "embeddings_count": len(e)} for n, e in _watchlist.items()]


@router.delete("/watchlist/{name}")
def delete_from_watchlist(name: str):
    with _state_lock:
        if name not in _watchlist:
            raise HTTPException(404, f"not on the watchlist: {name!r}")
        removed = len(_watchlist.pop(name))
        _save_watchlist()
    return {"name": name, "embeddings_removed": removed}


class ThresholdRequest(BaseModel):
    threshold: float | None = None
    min_face_px: int | None = None


@router.get("/threshold")
def get_threshold():
    with _state_lock:
        cfg, n = dict(_config), len(_watchlist)
        embeddings = sum(len(e) for e in _watchlist.values())
    return {**cfg, "startup_default": _startup_config, "floor": THRESHOLD_FLOOR,
            "watchlist_size": n, "embeddings_total": embeddings,
            "applies_within_seconds": _CFG["update_interval"]}


@router.put("/threshold")
def put_threshold(req: ThresholdRequest):
    """Takes effect on the NEXT detection cycle (<= wanted.update_interval), with
    no restart and no re-registration -- see _detect.

    Deliberately NOT persisted: a restart returns to config.json's value (or the
    measured default). config.json is the durable setting; this endpoint is for
    changing it while the service runs. The backend should re-apply on boot if it
    wants a different standing value."""
    if req.threshold is None and req.min_face_px is None:
        raise HTTPException(422, "provide threshold and/or min_face_px")
    warnings = []
    if req.threshold is not None:
        if not (THRESHOLD_FLOOR <= req.threshold <= 1.0):
            # A floor, not a range check: at or below the access-control-validated
            # 0.248 this feature accuses people routinely (see engine.py).
            raise HTTPException(422, f"threshold must be in [{THRESHOLD_FLOOR}, 1.0] -- "
                                     f"below that, open-set matching false-alarms constantly")
        if req.threshold < _startup_config["threshold"]:
            warnings.append(f"{req.threshold} is below the measured default "
                            f"{_startup_config['threshold']}, raising the false-accusation rate")
    if req.min_face_px is not None and not (16 <= req.min_face_px <= 1000):
        raise HTTPException(422, "min_face_px must be in [16, 1000]")
    with _state_lock:
        previous = dict(_config)
        if req.threshold is not None:
            _config["threshold"] = float(req.threshold)
        if req.min_face_px is not None:
            _config["min_face_px"] = int(req.min_face_px)
        cfg = dict(_config)
    # Keep GET /config truthful about what is running.
    CONFIG["wanted"]["threshold"] = cfg["threshold"]
    CONFIG["wanted"]["min_face_px"] = cfg["min_face_px"]
    return {**cfg, "previous": previous, "warnings": warnings,
            "applies_within_seconds": _CFG["update_interval"]}


class SourcesRequest(BaseModel):
    sources: dict[str, str]


@router.post("/sources")
def post_sources(req: SourcesRequest):
    service.set_sources(req.sources)
    return {"sources_known": sorted(service.sources())}


@router.get("/sources")
def get_sources():
    return service.sources()


@router.delete("/sources/{camera}")
def delete_source(camera: str):
    if camera not in service.sources():
        raise HTTPException(404, f"no such camera: {camera!r}")
    service.remove_source(camera)
    return {"camera": camera, "deleted": True}


@router.websocket("/alerts/stream")
async def alerts_stream(ws: WebSocket):
    """Snapshot on connect, then one {"type":"update","camera","detections"}
    message each time that camera's set of matched watchlist names changes.

    Each detection is {"class": <the person's name>, "confidence": <COSINE
    SIMILARITY, not a probability>, "bbox", "det_score", "face_px"}, and the
    highest-confidence one additionally carries "snapshot": a base64 JPEG of the
    triggering frame. Entries re-sent from the hold window carry "held": true and
    a bbox that is up to wanted.hold_cycles cycles stale.

    "detections": [] is the all-clear. Note it does NOT distinguish "nobody
    wanted is here" from "no faces at all" or "camera is dark" -- unknown people
    are deliberately never emitted, so this stream can't double as a liveness
    check (use GET /frame for that)."""
    await service.handle_connection(ws)
