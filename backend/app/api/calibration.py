from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import (
    camera_id_by_name,
    forward,
    raise_for_ai_status,
)
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import RoleName, User
from app.services import branch_scope as scope
from app.services.zone_reproject import redraw_world_zones


router = APIRouter(prefix="/calibration", tags=["Calibration"])

# The AI service's calibration and floor frame are site-wide, but every
# calibration is about a camera, and cameras belong to branches: a MANAGER
# only reads and changes their own branch's (app/services/branch_scope.py).
# The entry gates are one site-wide list, so a MANAGER's change replaces
# only the gates drawn on their own cameras.
CALIBRATION_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


def _camera_name(db: Session, camera_id: str, user: User) -> str:
    """Our camera id -> its AI name, 404 unknown, 403 another branch's."""
    return scope.ensure_camera_id(db, camera_id, user).name


def _translate_points_keys(
    db: Session, points: dict, *, to_name: bool, user: User | None = None
) -> dict:
    """SharedPoint/cross_check's `points` are {camera: [x,y]} - every key
    needs translating in whichever direction this call is going."""
    out = {}
    for key, value in points.items():
        if to_name:
            out[_camera_name(db, key, user)] = value
        else:
            # AI service mentioning a camera we don't recognise is its own
            # data, not a caller error - dropped rather than 404ing a read.
            camera_id = camera_id_by_name(db, key)
            if camera_id is not None:
                out[camera_id] = value
    return out


@router.get("", dependencies=CALIBRATION_ROLES)
def get_calibration(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    response = forward("GET", "/calibration")
    raise_for_ai_status(response)
    by_name: dict = response.json()
    own = scope.own_camera_names(db, current_user)
    out = []
    for name, entry in by_name.items():
        if own is not None and name not in own:
            continue
        camera_id = camera_id_by_name(db, name)
        if camera_id is None:
            continue
        diagnostics = dict(entry.get("diagnostics", {}))
        # aligned_to names the reference camera it was fit against - an AI
        # service name, same translation as everything else here, even
        # though the frontend doesn't render it today (BEFORE this fix it
        # would have leaked an AI-service name into a field this app's own
        # type declares as one of our uuids).
        if diagnostics.get("aligned_to"):
            translated = camera_id_by_name(db, diagnostics["aligned_to"])
            if translated is not None:
                diagnostics["aligned_to"] = translated
        # CameraCalibration.aligned (api/types.ts) is a top-level field the
        # screen actually reads (`byCamera.get(id)?.aligned`) - the AI
        # service itself only ever nests this inside diagnostics, so without
        # projecting it up here every camera silently read as "not aligned"
        # regardless of its real state. Found by live-testing this proxy
        # end to end, 2026-09-23 - not caught before because nothing had
        # exercised a real GET /calibration response against this screen.
        out.append(
            {
                "camera_id": camera_id,
                **entry,
                "aligned": diagnostics.get("aligned", False),
                "diagnostics": diagnostics,
            }
        )
    return out


@router.post("/rect", dependencies=CALIBRATION_ROLES)
def calibrate_rect(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    camera_name = _camera_name(db, payload["camera_id"], current_user)
    response = forward(
        "POST",
        "/calibration/rect",
        json={
            "camera": camera_name,
            "points": payload["points"],
            "img_w": payload["img_w"],
            "img_h": payload["img_h"],
        },
    )
    raise_for_ai_status(response)
    # The floor frame moved: world zones are re-converted from their pixels.
    return {**response.json(), "zones": redraw_world_zones(db)}


@router.post("/align", dependencies=CALIBRATION_ROLES)
def calibrate_align(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    points = [
        _translate_points_keys(db, point, to_name=True, user=current_user)
        for point in payload.get("points", [])
    ]
    response = forward("POST", "/calibration/align", json={"points": points})
    raise_for_ai_status(response)
    result = response.json()

    reference_id = camera_id_by_name(db, result["reference"])
    results = {}
    for name, entry in result.get("results", {}).items():
        camera_id = camera_id_by_name(db, name)
        if camera_id is None:
            continue
        entry = dict(entry)
        if entry.get("via"):
            entry["via"] = camera_id_by_name(db, entry["via"])
        results[camera_id] = entry

    residual_checks = []
    for check in result.get("residual_checks", []):
        pairs = []
        for pair in check.get("pairs", []):
            cam_a = camera_id_by_name(db, pair["cam_a"])
            cam_b = camera_id_by_name(db, pair["cam_b"])
            if cam_a is None or cam_b is None:
                continue
            pairs.append({**pair, "cam_a": cam_a, "cam_b": cam_b})
        residual_checks.append({"pairs": pairs})

    return {
        **result,
        "reference": reference_id,
        "results": results,
        "residual_checks": residual_checks,
        "zones": redraw_world_zones(db),
    }


@router.post("/cross_check", dependencies=CALIBRATION_ROLES)
def cross_check(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    points = _translate_points_keys(db, payload.get("points", {}), to_name=True, user=current_user)
    response = forward("POST", "/calibration/cross_check", json={"points": points})
    raise_for_ai_status(response)
    result = response.json()

    worlds = {}
    for name, value in result.get("worlds", {}).items():
        camera_id = camera_id_by_name(db, name)
        if camera_id is not None:
            worlds[camera_id] = value

    pairs = []
    for pair in result.get("pairs", []):
        cam_a = camera_id_by_name(db, pair["cam_a"])
        cam_b = camera_id_by_name(db, pair["cam_b"])
        if cam_a is None or cam_b is None:
            continue
        pairs.append({**pair, "cam_a": cam_a, "cam_b": cam_b})

    return {"worlds": worlds, "pairs": pairs}


def _all_gates() -> list:
    response = forward("GET", "/calibration/gates")
    raise_for_ai_status(response)
    return response.json()["gates"]


def _others_gates(db: Session, user: User) -> list:
    """The gates a MANAGER's change must keep: those on other branches'
    cameras (none for an ADMIN, who replaces the whole list)."""
    own = scope.own_camera_names(db, user)
    if own is None:
        return []
    return [g for g in _all_gates() if g.get("camera") not in own]


@router.get("/gates", dependencies=CALIBRATION_ROLES)
def get_gates(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list:
    own = scope.own_camera_names(db, current_user)
    return [g for g in _all_gates() if own is None or g.get("camera") in own]


@router.post("/gates", dependencies=CALIBRATION_ROLES)
def save_gates(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list:
    gates = [
        {"camera": _camera_name(db, entry["camera"], current_user), "points": entry["points"]}
        for entry in payload.get("gates", [])
    ]
    response = forward(
        "POST", "/calibration/gates", json={"gates": _others_gates(db, current_user) + gates}
    )
    raise_for_ai_status(response)
    own = scope.own_camera_names(db, current_user)
    return [g for g in response.json()["gates"] if own is None or g.get("camera") in own]


@router.delete("/gates", dependencies=CALIBRATION_ROLES)
def clear_gates(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    others = _others_gates(db, current_user)
    if scope.is_admin(current_user) or not others:
        response = forward("DELETE", "/calibration/gates")
    else:
        response = forward("POST", "/calibration/gates", json={"gates": others})
    raise_for_ai_status(response)


@router.delete("/{camera_id}", dependencies=CALIBRATION_ROLES)
def delete_calibration(
    camera_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    camera_name = _camera_name(db, camera_id, current_user)
    response = forward("DELETE", f"/calibration/{camera_name}")
    raise_for_ai_status(response)
