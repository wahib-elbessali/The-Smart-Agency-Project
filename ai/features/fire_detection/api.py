"""Deployable surface over engine.py, mounted at /fire by the unified app in
main.py. Identical shape to features/weapon_detection/api.py -- continuous,
always-on fire/smoke detection over the registered cameras, built on
features/common/live_alert_service.py.

- POST      /fire/sources         -- {"sources": {cam: url_or_path, ...}} merges
                                      into the camera registry.
- GET       /fire/sources          -- current camera registry.
- DELETE    /fire/sources/{camera} -- stop watching one camera.
- WebSocket /fire/alerts/stream    -- live per-camera detections, pushed only when
                                      the SET OF DETECTED CLASSES changes.

Frame preview is not duplicated here: the unified app serves one GET /frame and
GET /video_meta for every feature.

Tunables live in features/config.json under "fire": conf (0.25), imgsz (1280,
NOT the usual 640 -- see engine.py for the measurement behind that),
update_interval (2.0s).
"""
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import BaseModel

from ..common.live_alert_service import LiveAlertService
from ..config import CONFIG, on_change
from .engine import detect_fire

_CFG = CONFIG["fire"]   # read at call time: PATCH /config changes it live

service = LiveAlertService(feature_key='fire', 
    detect_fn=lambda frame: detect_fire(frame, conf=_CFG["conf"], imgsz=_CFG["imgsz"]),
    update_interval=_CFG["update_interval"],
)
on_change("fire", "update_interval", lambda v: setattr(service, "update_interval", v))

router = APIRouter(prefix="/fire", tags=["fire detection"])


@asynccontextmanager
async def lifespan():
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
    """Server push only: snapshot on connect, then one {"type":"update",
    "camera","detections"} message each time that camera's detected-class SET
    changes. The background detection loop keeps running whether or not anyone
    is connected."""
    await service.handle_connection(ws)
