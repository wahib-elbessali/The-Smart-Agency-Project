from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.counters import ensure_agency_scope, get_agency_or_404
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Camera, RoleName, User, Zone
from app.schemas.agency import ZoneCreate, ZoneResponse, ZoneUpdate


router = APIRouter(tags=["Access zones"])
ZONE_READ_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]
ZONE_WRITE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]

# Door access zones (the rooms an RFID door reader guards, checked by
# POST /internal/access/door-access against Employee.authorized_zones). Same
# gap counters.py closed: a Zone row was writable only inside POST /agencies,
# so a branch could never add, rename or remove a room afterwards, and no
# screen could list them to grant access. Not the AI service's camera zones
# (app/api/zones.py) - those are floor polygons, these are doors.


def get_zone_or_404(zone_id: str, db: Session) -> Zone:
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone introuvable")
    return zone


def check_door_camera(db: Session, agency_id: str, access_mode: str, door_camera_id: str | None) -> None:
    """A badge + face room needs a door camera of its own branch."""
    if door_camera_id is not None:
        camera = db.get(Camera, door_camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera introuvable")
        if camera.agency_id != agency_id:
            raise HTTPException(status_code=422, detail="Cette camera appartient a une autre agence")
    if access_mode == "rfid_face" and door_camera_id is None:
        raise HTTPException(
            status_code=422, detail="Une piece badge + visage a besoin d une camera de porte"
        )


def ensure_unique_name(db: Session, agency_id: str, name: str, exclude_id: str | None = None) -> None:
    query = select(Zone.id).where(Zone.agency_id == agency_id, func.lower(Zone.name) == name.lower())
    if exclude_id:
        query = query.where(Zone.id != exclude_id)
    if db.scalar(query) is not None:
        raise HTTPException(status_code=409, detail="Une zone porte deja ce nom dans cette agence")


@router.get(
    "/agencies/{agency_id}/access-zones",
    response_model=list[ZoneResponse],
    dependencies=ZONE_READ_ROLES,
)
def list_access_zones(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Zone]:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return list(db.scalars(select(Zone).where(Zone.agency_id == agency_id).order_by(Zone.name)).all())


@router.post(
    "/agencies/{agency_id}/access-zones",
    response_model=ZoneResponse,
    status_code=201,
    dependencies=ZONE_WRITE_ROLES,
)
def create_access_zone(
    agency_id: str,
    payload: ZoneCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Zone:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    name = payload.name.strip()
    ensure_unique_name(db, agency_id, name)
    check_door_camera(db, agency_id, payload.access_mode, payload.door_camera_id)
    zone = Zone(agency_id=agency_id, **{**payload.model_dump(), "name": name})
    db.add(zone)
    db.commit()
    db.refresh(zone)
    return zone


@router.put("/access-zones/{zone_id}", response_model=ZoneResponse, dependencies=ZONE_WRITE_ROLES)
def update_access_zone(
    zone_id: str,
    payload: ZoneUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Zone:
    zone = get_zone_or_404(zone_id, db)
    ensure_agency_scope(zone.agency_id, current_user)
    changes = payload.model_dump(exclude_unset=True)
    for required in ("name", "zone_type", "is_private"):
        if required in changes and changes[required] is None:
            raise HTTPException(status_code=422, detail=f"{required} ne peut pas etre vide")
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        ensure_unique_name(db, zone.agency_id, changes["name"], exclude_id=zone.id)
    if changes.get("access_mode", "") is None:
        raise HTTPException(status_code=422, detail="access_mode ne peut pas etre vide")
    check_door_camera(
        db,
        zone.agency_id,
        changes.get("access_mode", zone.access_mode),
        changes["door_camera_id"] if "door_camera_id" in changes else zone.door_camera_id,
    )
    for field, value in changes.items():
        setattr(zone, field, value)
    db.commit()
    db.refresh(zone)
    return zone


@router.delete("/access-zones/{zone_id}", status_code=204, dependencies=ZONE_WRITE_ROLES)
def delete_access_zone(
    zone_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    zone = get_zone_or_404(zone_id, db)
    ensure_agency_scope(zone.agency_id, current_user)
    # The many-to-many rows granting employees this zone go with it; a door
    # reader still configured for this zone id then gets 404 and stays shut.
    db.delete(zone)
    db.commit()
