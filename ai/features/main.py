"""The single deployed API. One process, one port, every feature.

    uvicorn features.main:app --host 0.0.0.0 --port 8000

Lives in features/ rather than at the repo root because everything deployed
lives under features/ -- the root holds research/tooling (architectures/,
evaluation/, experiments/, reference_ui/), which is not shipped. Named main.py
rather than api.py so the name `api.py` stays reserved for a single feature's
endpoint module; this file composes them rather than defining any of its own.

Each feature still owns its own file pair under features/<name>/ (engine.py =
the CV script, api.py = its endpoints); api.py now exposes an APIRouter instead
of its own FastAPI app, and this module mounts them all under a prefix. That
replaces the previous arrangement of seven separate services on ports 8001-8007.

WHY ONE PROCESS, beyond having one address to point a backend at: three features
(face recognition, emotion detection, wanted detection) all sit on InsightFace's
buffalo_s pack. As separate processes each loaded its own ~120MB copy; sharing
one interpreter means one copy, which is the difference between comfortable and
marginal on the Raspberry Pi 4 deployment target. Total CPU is unchanged -- the
same background loops run either way -- but memory drops sharply and there is
one lifecycle to manage instead of seven.

Route map (full detail in each feature's api.py docstring):

    GET  /                          this map, as JSON
    /cameras                        the site camera table (url, quality,
                                    which features watch each camera)
    GET  /frame?camera=|source=     one PNG frame (camera= applies its quality)
    GET  /video_meta?source=        {n_frames, fps, width, height}

    /calibration/...                homography per camera + multi-camera alignment
    /zoning/zones, /zoning/occupancy/stream
    /employee_activity/workstations, /employee_activity/status/stream
    /people/sources, /people/status, /people/tracks/stream
    /face/enroll, /face/faces, /face/scan
    /weapon/sources, /weapon/alerts/stream
    /fire/sources,   /fire/alerts/stream
    /emotion/sources,/emotion/alerts/stream
    /wanted/watchlist, /wanted/threshold, /wanted/sources, /wanted/alerts/stream

/frame and /video_meta live HERE rather than in each feature because they were
six byte-identical copies of the same eight lines; they are source-agnostic
utilities, not per-feature endpoints.

NO AUTHENTICATION, CORS WIDE OPEN. Every endpoint is open to anyone who can
reach the port -- a deliberate choice for an academic project, where the
per-feature X-API-Key scheme was more ceremony than it was worth. CORS is
allow_origins=["*"] for the same reason (needed for reference_ui/console/ and
any other browser frontend to call this from a different origin) -- it adds
no new risk on top of "no auth", since the API was already reachable from
anywhere that can hit the port. Before this is exposed to anything beyond a
trusted LAN it needs auth put back and CORS restricted together, and note
that two of these streams are more sensitive than the rest:
/wanted/alerts/stream broadcasts the names of people flagged as wanted (with
a photo of them attached), and /face + /wanted can both read out stored
biometric embeddings. Put this behind an authenticating reverse proxy with
TLS, or restore the API-key dependency, before real use.
"""
import io
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import cv2
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .common import cameras as registry
from .common import route_walk
from .common.video_source import read_frame, video_meta as _video_meta
from .config import CONFIG, ConfigError, apply_changes, describe, reload_from_file
from . import paths
from .calibration import api as calibration
from .cameras import api as cameras
from .emotion_detection import api as emotion_detection
from .employee_activity import api as employee_activity
from .face_recognition import api as face_recognition
from .fire_detection import api as fire_detection
from .person_tracking import api as person_tracking
from .wanted_detection import api as wanted_detection
from .weapon_detection import api as weapon_detection
from .zoning import api as zoning

# employee_activity after zoning: it reads zoning's already-computed
# occupancy (get_zone_count()) at import time inside its own module, and
# its background loop polls the same live state every cycle -- order here
# doesn't affect that (Python has already fully imported zoning by the time
# employee_activity's own imports run), but keeping it adjacent to zoning in
# this list documents the dependency for a reader.
FEATURES = [cameras, calibration, zoning, employee_activity, person_tracking, face_recognition,
            weapon_detection, fire_detection, emotion_detection, wanted_detection]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Starts every feature that has background work (the four alert streams and
    zoning's occupancy loop) and stops them in reverse order on shutdown.

    AsyncExitStack rather than a hand-written try/finally chain: if the third
    feature's startup raises, the two already started are still unwound
    correctly, and no detection loop is left running against a half-built app.
    Features with no background work (calibration, face recognition) simply
    don't define `lifespan`."""
    async with AsyncExitStack() as stack:
        for feature in FEATURES:
            if hasattr(feature, "lifespan"):
                await stack.enter_async_context(feature.lifespan())
        yield


app = FastAPI(
    title="smartAgencyAI",
    description="Computer-vision layer of the Système de Gestion des Agences.",
    lifespan=lifespan,
)

# Wide open, matching the "no authentication" stance documented above -- this
# service already trusts anything that can reach the port, so a browser-based
# frontend (e.g. reference_ui/console/, a real product frontend) needing a
# different origin to call it is not a new risk model. Restrict this (and add
# auth) together, before anything beyond a trusted LAN.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

for feature in FEATURES:
    app.include_router(feature.router)


@app.get("/", tags=["meta"])
def index():
    """Every mounted path, so a backend can discover the surface without the
    OpenAPI schema (which is also served, at /docs)."""
    routes = [{"path": p, "methods": m} for p, m in route_walk.iter_routes(app)]
    return {"service": "smartAgencyAI", "features": [f.router.prefix for f in FEATURES],
            "routes": routes}


@app.get("/config", tags=["meta"])
def get_config():
    """The effective tunables, and where the service keeps its data.

    `config` is what is running now. `apply_modes` says, per key, how a change
    takes effect: "live" (next detection cycle), "next_start" (used when
    person_tracking next bootstraps) or "restart". `startup_config` is what the
    file said at boot, so a live change is visible as a difference, and
    `pending_restart` lists restart-mode values already written to config.json
    that are not running yet. Change values with PATCH /config."""
    return {"config": CONFIG,
            **describe(),
            "config_file": str(paths.CONFIG_FILE),
            "data_dir": str(paths.DATA),
            "models_dir": str(paths.MODELS)}


class ConfigPatch(BaseModel):
    changes: dict[str, dict[str, Any]]
    persist: bool = False


def _config_422(exc: ConfigError):
    raise HTTPException(422, {"message": "config not changed", "errors": exc.errors})


@app.patch("/config", tags=["meta"])
def patch_config(req: ConfigPatch):
    """Change tunables while the service runs -- no restart, cameras stay registered.

    Body: {"changes": {"weapon": {"conf": 0.4}, "wanted": {"threshold": 0.55}},
           "persist": false}

    All-or-nothing: if any value is invalid the response is 422 listing every
    problem and nothing changes. "live" keys apply on the next detection cycle
    (within that feature's update_interval); "next_start" keys are stored and
    used when person_tracking next bootstraps. "restart" keys (weights, detector
    backend, face pack, det_size) are refused unless persist=true, which writes
    them to config.json for the next start.

    Without persist the change lasts until the process restarts and config.json
    remains the durable default. With persist=true the changed values are also
    merged into config.json (atomic replace)."""
    try:
        return apply_changes(req.changes, persist=req.persist)
    except ConfigError as exc:
        _config_422(exc)


@app.post("/config/reload", tags=["meta"])
def reload_config():
    """Re-read config.json and apply whatever differs from what is running
    (live keys now, restart keys reported under pending_restart). For editing
    the file by hand and applying it without a restart. All-or-nothing."""
    try:
        return reload_from_file()
    except ConfigError as exc:
        _config_422(exc)
    except (OSError, ValueError) as exc:
        raise HTTPException(422, {"message": "config.json unreadable", "errors": [str(exc)]})


@app.get("/frame", tags=["meta"])
def get_frame(source: str | None = None, camera: str | None = None,
              index: int | None = None, format: str = "png", quality: int = 80):
    """?camera=<id> (preferred) or ?source=<path or rtsp url>, &index=<n> -> one PNG.

    `camera` looks the url AND the quality up in the camera table, so the
    PNG returned is the same size as the frames the detectors actually see.
    That matters for anything drawing boxes over this image: `source` alone
    returns the camera's NATIVE frame, and overlaying half-resolution boxes
    on a full-resolution preview puts every box in the wrong place."""
    cam_quality = 1.0
    if camera is not None:
        entry = registry.get(camera)
        if entry is None or not entry.get("url"):
            raise HTTPException(404, f"camera {camera!r} is not in the camera table, "
                                     f"or has no url")
        source, cam_quality = entry["url"], float(entry.get("quality", 1.0))
    if source is None:
        raise HTTPException(400, "give either ?camera=<id> or ?source=<path or url>")
    frame = read_frame(source, index, quality=cam_quality)
    if frame is None:
        raise HTTPException(404, f"could not read a frame from source: {source!r}")
    # PNG is the default because calibration clicks pixels on this image and
    # must see exactly what the detector sees. A live PREVIEW does not need
    # that: encoding a 1920x1080 PNG per frame caps a viewer at well under
    # 1 fps, so format=jpeg exists for anything that just wants to watch.
    if format.lower() in ("jpg", "jpeg"):
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        return StreamingResponse(io.BytesIO(buf.tobytes()), media_type="image/jpeg")
    ok, buf = cv2.imencode(".png", frame)
    return StreamingResponse(io.BytesIO(buf.tobytes()), media_type="image/png")


@app.get("/video_meta", tags=["meta"])
def get_video_meta(source: str):
    """?source=... -> {n_frames, fps, width, height}."""
    meta = _video_meta(source)
    if meta is None:
        raise HTTPException(404, f"could not open source: {source!r}")
    return meta
