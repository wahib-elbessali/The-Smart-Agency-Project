"""Deployable surface over engine.py, mounted at /emotion by the unified app in
main.py. Continuous, always-on customer-mood detection across whatever cameras
are registered -- same shape as features/weapon_detection/api.py and
features/fire_detection/api.py, all built on features/common/live_alert_service.py.

REAL LIMITATION, not a hypothetical caveat -- read before deploying: this
only works well on a camera CLOSE to where the interaction actually happens
(a checkout counter, a service desk), where faces are naturally large and
front-on. Tested against this project's own real wide/low-res
multi-camera footage (360x288, faces 10-30px across): confidence dropped to
0.27-0.37 (barely above the 1/8 random-chance floor for 8 emotion classes),
consistent with the classifier reading upsampling noise, not real
expression. Re-tested against genuine 1920x1080 HD footage (Wildtrack,
already in this repo): resolution DOES help (0.25-0.63 on typical
30-100px faces, tracking crop size) but even the single largest, sharpest,
front-facing face found across the whole dataset (211x262px, visually
confirmed) only scored 0.505 -- nowhere near the 0.995 seen on a posed
close-up smiling photo, because that face showed a real CANDID expression
(squinting, mid-stride), not a deliberately posed extreme one. Two
independent limits, not one: distance/resolution AND real-world expression
ambiguity -- HD helps with the first, fixes neither by itself. Expect
moderate confidence (roughly 0.4-0.6) from genuine customer interactions
even on excellent close footage; don't calibrate alert thresholds against
posed-photo intuition. See docs/live_alerts.md for the full writeup.

- POST      /emotion/sources         -- {"sources": {cam: url_or_path, ...}} merges
                                         into the camera registry (accumulates
                                         across calls). Once >=1 source exists,
                                         detection runs continuously in the
                                         background.
- GET       /emotion/sources          -- current camera registry.
- DELETE    /emotion/sources/{camera} -- stop watching one camera.
- WebSocket /emotion/alerts/stream    -- live per-camera detections, pushed only
                                         when the SET OF DETECTED EMOTION LABELS
                                         for a camera changes.

Frame preview is not duplicated here: the unified app serves one GET /frame and
GET /video_meta for every feature.

Tunables live in features/config.json under "emotion": det_size (640 -- see
engine.py for why increasing this does NOT fix distant/tiny faces),
update_interval (seconds between detection cycles, 2.0).
"""
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import BaseModel

from ..common.live_alert_service import LiveAlertService
from ..config import CONFIG, on_change
from .engine import detect_emotions

_CFG = CONFIG["emotion"]
DET_SIZE = _CFG["det_size"]   # restart-only: the shared face engine is prepared once at this size

service = LiveAlertService(feature_key='emotion', 
    detect_fn=lambda frame: detect_emotions(frame, det_size=(DET_SIZE, DET_SIZE)),
    update_interval=_CFG["update_interval"],
)
on_change("emotion", "update_interval", lambda v: setattr(service, "update_interval", v))

router = APIRouter(prefix="/emotion", tags=["emotion detection"])


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
    "camera","detections"} message each time that camera's detected-emotion SET
    changes. The background detection loop keeps running whether or not anyone
    is connected."""
    await service.handle_connection(ws)
