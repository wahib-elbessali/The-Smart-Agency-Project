from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import (
    camera_id_by_name,
    forward,
    raise_for_ai_status,
)
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Camera, RoleName, User
from app.services import branch_scope as scope


router = APIRouter(prefix="/people", tags=["Person tracking"])

# Reading is a monitoring view (SECURITY can see the live map, same bucket
# as /alerts); writing the source registry is configuration, ADMIN/MANAGER
# only - matches the frontend's own mocks/roles.ts split exactly. Tracking
# runs over the whole site, but the cameras feeding it belong to branches:
# a non-admin reads and changes only their own branch's
# (app/services/branch_scope.py).
READ_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]
WRITE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


def _names_to_ids(db: Session, names: list[str] | None, user: User | None = None) -> list[str]:
    if not names:
        return []
    own = scope.own_camera_names(db, user) if user is not None else None
    ids = [camera_id_by_name(db, name) for name in names if own is None or name in own]
    return [i for i in ids if i is not None]


@router.get("/status", dependencies=READ_ROLES)
def get_status(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    response = forward("GET", "/people/status")
    raise_for_ai_status(response)
    result = response.json()
    # cams_bootstrapped is a list of AI-service camera NAMES - translated
    # for the same reason every other camera-shaped field here is: the
    # browser only ever sees our uuids.
    result["cams_bootstrapped"] = (
        None
        if result.get("cams_bootstrapped") is None
        else _names_to_ids(db, result["cams_bootstrapped"], current_user)
    )
    return result


@router.get("/sources", dependencies=READ_ROLES)
def get_sources(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    response = forward("GET", "/people/sources")
    raise_for_ai_status(response)
    result = response.json()
    return {
        "sources_known": _names_to_ids(db, result.get("sources_known"), current_user),
        "calibrated": _names_to_ids(db, result.get("calibrated"), current_user),
        "aligned": _names_to_ids(db, result.get("aligned"), current_user),
    }


@router.post("/sources", dependencies=WRITE_ROLES)
def register_sources(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    sources = {}
    for camera_id in payload.get("camera_ids", []):
        camera = db.get(Camera, camera_id)
        if camera is None:
            continue
        scope.camera_in_scope(db, camera, current_user)
        if camera.stream_url is not None:
            sources[camera.name] = camera.stream_url
    response = forward("POST", "/people/sources", json={"sources": sources})
    raise_for_ai_status(response)
    result = response.json()
    return {
        "sources_known": _names_to_ids(db, result.get("sources_known"), current_user),
        "calibrated": _names_to_ids(db, result.get("calibrated"), current_user),
        "aligned": _names_to_ids(db, result.get("aligned"), current_user),
        "warnings": result.get("warnings", []),
    }


@router.delete("/sources/{camera_id}", dependencies=WRITE_ROLES)
def remove_source(
    camera_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    camera_name = scope.ensure_camera_id(db, camera_id, current_user).name
    response = forward("DELETE", f"/people/sources/{camera_name}")
    raise_for_ai_status(response)
    return {"camera": camera_id, "deleted": True}
