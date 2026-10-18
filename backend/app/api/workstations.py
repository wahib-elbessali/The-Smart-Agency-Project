from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import camera_id_by_name, forward, raise_for_ai_status
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Camera, RoleName, User


router = APIRouter(prefix="/workstations", tags=["Workstations"])
WORKSTATION_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]

# Proxies contracts/ai-service.md §/employee_activity - see zones.py's
# identical shape, which this copies rather than imports from: a workstation
# is scoped through the zone it watches exactly the way a world zone is
# scoped through the camera it was drawn from, same reasoning, same helper
# shape, two different upstream resources.


def _agency_of_zone(db: Session, zone_name: str, zones_by_name: dict) -> str | None:
    zone = zones_by_name.get(zone_name)
    if zone is None:
        return None
    name = zone.get("camera") or (zone.get("converted_from") or {}).get("camera")
    if name is None:
        return None
    camera_id = camera_id_by_name(db, name)
    if camera_id is None:
        return None
    camera = db.get(Camera, camera_id)
    return camera.agency_id if camera else None


def _visible(db: Session, current_user: User, workstations: list[dict], zones_by_name: dict) -> list[dict]:
    if current_user.role.name == RoleName.ADMIN:
        return workstations
    return [
        workstation
        for workstation in workstations
        if _agency_of_zone(db, workstation["zone"], zones_by_name) == current_user.agency_id
    ]


def _zones_by_name() -> dict:
    response = forward("GET", "/zoning/zones")
    raise_for_ai_status(response)
    return response.json()


@router.get("", dependencies=WORKSTATION_ROLES)
def list_workstations(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    response = forward("GET", "/employee_activity/workstations")
    raise_for_ai_status(response)
    return _visible(db, current_user, response.json(), _zones_by_name())


@router.post("", dependencies=WORKSTATION_ROLES)
def create_workstation(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    zones_by_name = _zones_by_name()
    zone = zones_by_name.get(payload.get("zone"))
    # A zone the caller cannot already see is not a zone they may bind a
    # workstation to, even though the AI service itself has no notion of an
    # agency to refuse this with. A zone that does not exist AT ALL is left
    # to the AI service's own 422 below - nothing to scope-check yet.
    if zone is not None and current_user.role.name != RoleName.ADMIN:
        agency_id = _agency_of_zone(db, payload["zone"], zones_by_name)
        if agency_id is None or agency_id != current_user.agency_id:
            raise HTTPException(status_code=403, detail="Acces limite a votre agence")

    response = forward(
        "POST",
        "/employee_activity/workstations",
        json={"name": payload["name"], "zone": payload["zone"]},
    )
    raise_for_ai_status(response)
    return response.json()


@router.delete("/{name}", dependencies=WORKSTATION_ROLES)
def delete_workstation(
    name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    response = forward("GET", "/employee_activity/workstations")
    raise_for_ai_status(response)
    workstation = next((w for w in response.json() if w["name"] == name), None)
    if workstation is None:
        raise HTTPException(status_code=404, detail="Poste de travail introuvable")

    if current_user.role.name != RoleName.ADMIN:
        agency_id = _agency_of_zone(db, workstation["zone"], _zones_by_name())
        if agency_id is None or agency_id != current_user.agency_id:
            raise HTTPException(status_code=403, detail="Acces limite a votre agence")

    delete_response = forward("DELETE", f"/employee_activity/workstations/{name}")
    raise_for_ai_status(delete_response)
