"""The camera table -- define a camera once, then pick which features use it.

- GET    /cameras                     -- the whole table
- POST   /cameras                     -- create/update one camera
                                         {"id","url","name","quality","features"}
                                         Only the fields sent are changed.
- DELETE /cameras/{id}                -- remove it from the table
- PUT    /cameras/{id}/features       -- {"features": ["people","zoning"]}
- PUT    /cameras/{id}/quality        -- {"quality": 0.5}

Every feature that watches cameras reads its list from here, so a camera is
described in ONE place and survives a restart. Each feature keeps its own
`POST .../sources` as before; that now writes into this table rather than
into a private dict, so existing clients keep working and the table stays
the single truth.

QUALITY is a fraction of native resolution, per camera (1.0 = full,
0.5 = half each side). It cannot break calibration: the homography is
re-scaled from the resolution it was fitted at to whatever the frame
actually is -- see common/cameras.py and calibration/engine.scale_Hinv for
why that is done from the frame rather than from this number.

Changing quality or a feature assignment takes effect on the next detection
cycle. /people is the exception: its bootstrap measured the scene at the old
size, so this re-bootstraps it -- reported in the response rather than done
silently, because a re-bootstrap drops every track id.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..common import cameras as registry

router = APIRouter(prefix="/cameras", tags=["cameras"])


class CameraRequest(BaseModel):
    id: str
    url: str | None = None
    name: str | None = None
    quality: float | None = None
    features: list[str] | None = None


class FeaturesRequest(BaseModel):
    features: list[str]


class QualityRequest(BaseModel):
    quality: float


def _resolution_note(cam_id):
    """Warn when a camera is assigned to a geometry feature but has no
    calibration -- /people and world-mode zones need one, and the failure
    without it is a feature that simply never starts."""
    from ..calibration.engine import load_calibration
    from ..paths import CALIBRATION
    cal = load_calibration(CALIBRATION)
    entry = registry.get(cam_id) or {}
    feats = set(entry.get("features", []))
    notes = []
    if feats & {"people", "zoning"} and cam_id not in cal:
        notes.append(f"camera {cam_id} is assigned to {sorted(feats & {'people', 'zoning'})} "
                     f"but is not calibrated -- POST /calibration/rect, then /calibration/align")
    elif cam_id in cal and not cal[cam_id].get("diag", {}).get("calib_res"):
        notes.append(f"camera {cam_id}'s calibration predates resolution tracking; it will be "
                     f"used as-is and CANNOT be rescaled if quality is changed. Re-run "
                     f"POST /calibration/rect to record it.")
    return notes


@router.get("")
def list_cameras():
    """The table. `features` is which features watch each camera."""
    return {"cameras": registry.all_cameras(), "valid_features": list(registry.FEATURES)}


@router.post("")
def upsert_camera(req: CameraRequest):
    try:
        entry = registry.upsert(req.id, url=req.url, name=req.name,
                                quality=req.quality, features=req.features)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"id": req.id, "camera": entry, "warnings": _resolution_note(req.id)}


@router.delete("/{cam_id}")
def delete_camera(cam_id: str):
    return {"id": cam_id, "deleted": registry.remove(cam_id)}


@router.put("/{cam_id}/features")
def set_features(cam_id: str, req: FeaturesRequest):
    if registry.get(cam_id) is None:
        raise HTTPException(404, f"no camera {cam_id!r} in the table -- POST /cameras first")
    try:
        entry = registry.upsert(cam_id, features=req.features)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"id": cam_id, "camera": entry, "warnings": _resolution_note(cam_id)}


@router.put("/{cam_id}/quality")
def set_quality(cam_id: str, req: QualityRequest):
    if registry.get(cam_id) is None:
        raise HTTPException(404, f"no camera {cam_id!r} in the table -- POST /cameras first")
    try:
        entry = registry.upsert(cam_id, quality=req.quality)
    except ValueError as e:
        raise HTTPException(400, str(e))

    warnings = _resolution_note(cam_id)
    # /people measured this scene (person-width, room extent, head
    # homographies) at the old frame size. Those are all in world units so
    # most survive, but the head homographies are fitted in PIXELS and do
    # not -- so the honest move is a re-bootstrap, and the honest thing to
    # report is that it costs the track ids.
    from ..person_tracking import api as people
    if "people" in (entry.get("features") or []) and people._state["phase"] == "running":
        people.request_rebootstrap()
        warnings.append("/people is re-bootstrapping at the new resolution -- "
                        "existing track ids are lost")
    return {"id": cam_id, "camera": entry, "warnings": warnings}
