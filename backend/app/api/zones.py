from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import camera_id_by_name, forward, raise_for_ai_status
from app.api.cameras import get_camera_or_404
from app.api.devices import ensure_agency_scope
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Alert, Camera, Device, RoleName, User, ZoneRule
from app.services.zone_watch import ACTIVE, INTRUSION, floor_polygon


router = APIRouter(prefix="/zones", tags=["Zones"])
ZONE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]
WATCH_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]


class RestrictionUpdate(BaseModel):
    """anyone: no rule. staff: only people linked to an employee of the
    branch. nobody: no one at all (app/services/zone_watch.py)."""

    restriction: Literal["anyone", "staff", "nobody"]


def _agency_of_zone(db: Session, zone: dict, current_user: User) -> str | None:
    """Which agency a zone belongs to, or None if nothing here can prove
    one - a pixel zone reads it off its camera, a world zone falls back to
    converted_from's camera. Mirrors the frontend mock's own agencyOfZone,
    now against the real database instead of a fixture."""
    name = zone.get("camera") or (zone.get("converted_from") or {}).get("camera")
    if name is None:
        return None
    camera_id = camera_id_by_name(db, name)
    if camera_id is None:
        return None
    camera = db.get(Camera, camera_id)
    return camera.agency_id if camera else None


def _visible(db: Session, current_user: User, zones_by_name: dict) -> dict:
    if current_user.role.name == RoleName.ADMIN:
        return zones_by_name
    return {
        name: zone
        for name, zone in zones_by_name.items()
        if _agency_of_zone(db, zone, current_user) == current_user.agency_id
    }


def _restriction(db: Session, name: str, zone: dict, current_user: User) -> str:
    agency_id = _agency_of_zone(db, zone, current_user)
    if agency_id is None:
        return "anyone"
    rule = db.scalar(
        select(ZoneRule).where(ZoneRule.agency_id == agency_id, ZoneRule.zone_name == name)
    )
    return rule.restriction if rule else "anyone"


def _to_response(db: Session, name: str, zone: dict, current_user: User | None = None) -> dict:
    mode = zone["mode"]
    restriction = _restriction(db, name, zone, current_user) if current_user else "anyone"
    if mode == "pixel":
        return {
            "name": name,
            "mode": "pixel",
            "camera_id": camera_id_by_name(db, zone["camera"]),
            "polygon_px": zone.get("polygon_px"),
            "polygon_m": None,
            "converted_from": None,
            "restriction": restriction,
        }
    # World mode: camera_id is ALWAYS null, by design - see CameraZone's
    # doc comment on the frontend. converted_from.camera is kept as the AI
    # service's own camera NAME rather than translated to our uuid - it's
    # shown to a human as "drawn from X", where the name is more useful
    # than an id would be, and it's not sensitive the way a stream URL is.
    return {
        "name": name,
        "mode": "world",
        "camera_id": None,
        "polygon_px": None,
        "polygon_m": zone.get("polygon_m"),
        "converted_from": zone.get("converted_from"),
        "restriction": restriction,
    }


@router.get("", dependencies=ZONE_ROLES)
def list_zones(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    response = forward("GET", "/zoning/zones")
    raise_for_ai_status(response)
    zones_by_name = _visible(db, current_user, response.json())
    return [_to_response(db, name, zone, current_user) for name, zone in zones_by_name.items()]


@router.get("/intruders", dependencies=WATCH_ROLES)
def list_intruders(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    """The tracked people with an active intrusion alert, for the live map's
    marker. Registered before the /{name} routes."""
    query = select(Alert).where(
        Alert.alert_type == INTRUSION,
        Alert.status.in_(ACTIVE),
        Alert.tracking_id.is_not(None),
    )
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Alert.agency_id == current_user.agency_id)
    return [
        {"alert_id": a.id, "tracking_id": a.tracking_id, "title": a.title}
        for a in db.scalars(query).all()
    ]


@router.put("/{name}/restriction", dependencies=ZONE_ROLES)
def set_restriction(
    name: str,
    payload: RestrictionUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Who may stand in this zone. Only a world zone can be watched: the
    check compares tracked floor positions with the zone's floor outline."""
    response = forward("GET", "/zoning/zones")
    raise_for_ai_status(response)
    zone = response.json().get(name)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone introuvable")
    agency_id = _agency_of_zone(db, zone, current_user)
    if agency_id is None:
        raise HTTPException(status_code=422, detail="Zone sans camera connue")
    ensure_agency_scope(agency_id, current_user)
    if payload.restriction != "anyone" and floor_polygon(zone) is None:
        raise HTTPException(
            status_code=422,
            detail="Seule une zone world (suivi des personnes) peut etre surveillee",
        )

    rule = db.scalar(
        select(ZoneRule).where(ZoneRule.agency_id == agency_id, ZoneRule.zone_name == name)
    )
    if payload.restriction == "anyone":
        if rule is not None:
            db.delete(rule)
    elif rule is None:
        db.add(ZoneRule(agency_id=agency_id, zone_name=name, restriction=payload.restriction))
    else:
        rule.restriction = payload.restriction
    db.commit()
    warnings = []
    if payload.restriction == "staff" and not db.scalar(
        select(Device.id).where(Device.agency_id == agency_id, Device.badge_zone_name.is_not(None))
    ):
        # Staff are recognised by a badge tap linking them to a tracked person.
        warnings.append(
            "Aucun lecteur de badge n'a de zone de badge: personne ne sera reconnu comme "
            "personnel, tout le monde dans cette zone declenchera une alerte."
        )
    return {"name": name, "restriction": payload.restriction, "warnings": warnings}


@router.post("", dependencies=ZONE_ROLES)
def create_zone(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    camera = get_camera_or_404(payload["camera_id"], db)
    ensure_agency_scope(camera.agency_id, current_user)

    extra_ids = payload.get("extra_camera_ids") or []
    extra_cameras = []
    for extra_id in extra_ids:
        extra_camera = get_camera_or_404(extra_id, db)
        ensure_agency_scope(extra_camera.agency_id, current_user)
        extra_cameras.append(extra_camera)

    if camera.stream_url is None:
        raise HTTPException(status_code=422, detail="Cette camera n'a pas de flux configure")
    sources = {camera.name: camera.stream_url}
    for extra_camera in extra_cameras:
        if extra_camera.stream_url is None:
            raise HTTPException(
                status_code=422, detail=f"La camera {extra_camera.name} n'a pas de flux configure"
            )
        sources[extra_camera.name] = extra_camera.stream_url

    response = forward(
        "POST",
        "/zoning/zones",
        json={
            "name": payload["name"],
            "camera": camera.name,
            "polygon": payload["polygon"],
            "sources": sources,
        },
    )
    raise_for_ai_status(response)
    result = response.json()

    world = result["mode"] == "world"
    return {
        "name": result["name"],
        "mode": result["mode"],
        "camera_id": None if world else camera.id,
        "polygon_px": None if world else payload["polygon"],
        "polygon_m": result.get("polygon_m"),
        "converted_from": result.get("converted_from"),
        "warnings": result.get("warnings", []),
    }


@router.delete("/{name}", dependencies=ZONE_ROLES)
def delete_zone(
    name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    # Has to know which agency owns this zone BEFORE deleting it, so a
    # MANAGER can't delete a zone they were never scoped to see in the
    # first place. Costs a read the AI service doesn't otherwise need for
    # a delete, same trade every scoped write here makes.
    list_response = forward("GET", "/zoning/zones")
    raise_for_ai_status(list_response)
    zones_by_name = list_response.json()
    zone = zones_by_name.get(name)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone introuvable")

    if current_user.role.name != RoleName.ADMIN:
        agency_id = _agency_of_zone(db, zone, current_user)
        if agency_id is None or agency_id != current_user.agency_id:
            raise HTTPException(status_code=403, detail="Acces limite a votre agence")

    response = forward("DELETE", f"/zoning/zones/{name}")
    raise_for_ai_status(response)
    agency_id = _agency_of_zone(db, zone, current_user)
    if agency_id is not None:
        db.execute(
            delete(ZoneRule).where(ZoneRule.agency_id == agency_id, ZoneRule.zone_name == name)
        )
        db.commit()
