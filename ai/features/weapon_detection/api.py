"""Deployable surface over engine.py, mounted at /weapon by the unified app in
main.py. Continuous, always-on weapon detection across whatever cameras are
registered -- no zones/floor-position concept (unlike features/zoning), no
per-event trigger (unlike face_recognition's /scan): this is meant to always be
watching every registered camera and alert the instant a weapon-class appears in
ANY of them, using features/common/live_alert_service.py (shared with fire, emotion and
wanted detection).

- POST      /weapon/sources         -- {"sources": {cam: url_or_path, ...}} merges
                                        into the camera registry (accumulates
                                        across calls, same convention as zoning's
                                        POST /zones `sources` field). Once >=1
                                        source exists, detection runs continuously
                                        in the background.
- GET       /weapon/sources          -- current camera registry.
- DELETE    /weapon/sources/{camera} -- stop watching one camera.
- WebSocket /weapon/alerts/stream    -- live per-camera detections, pushed only
                                        when the SET OF DETECTED CLASSES for a
                                        camera changes (see
                                        features/common/live_alert_service.py for why --
                                        confidence-score jitter alone must not
                                        trigger a push).

Frame preview is not duplicated here: the unified app serves one GET /frame and
GET /video_meta for every feature, since they were six byte-identical copies.

Tunables live in features/config.json under "weapon": conf (0.25), imgsz
(640), update_interval (seconds between detection cycles, 2.0).
"""
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import BaseModel

from ..common.live_alert_service import LiveAlertService
from ..config import CONFIG, on_change
from .engine import detect_weapons

_CFG = CONFIG["weapon"]   # read at call time: PATCH /config changes it live

service = LiveAlertService(feature_key='weapon', 
    detect_fn=lambda frame: detect_weapons(frame, conf=_CFG["conf"], imgsz=_CFG["imgsz"]),
    update_interval=_CFG["update_interval"],
)
on_change("weapon", "update_interval", lambda v: setattr(service, "update_interval", v))

router = APIRouter(prefix="/weapon", tags=["weapon detection"])


@asynccontextmanager
async def lifespan():
    """Entered by features/main.py's composed lifespan -- takes no `app` argument
    because it is not attached to a FastAPI instance directly."""
    await service.start()
    yield
    await service.stop()


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
    """Server push only: connect and immediately get a snapshot of every
    camera's currently-known detections, then one {"type":"update",
    "camera","detections"} message each time that camera's detected-class
    SET changes (appears/disappears/composition changes) -- not a fixed
    heartbeat, not every confidence-score jitter. The background detection
    loop keeps running whether or not anyone is connected."""
    await service.handle_connection(ws)
