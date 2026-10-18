from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Alert, AlertStatus, Employee, RoleName, User
from app.schemas.alert import AlertResponse
from app.services.track_links import link_track
from app.services.zone_watch import INTRUSION


router = APIRouter(prefix="/agencies/{agency_id}/alerts", tags=["Alerts"])
actions_router = APIRouter(prefix="/alerts", tags=["Alerts"])
ALERT_READ_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))
]


@router.get("", response_model=list[AlertResponse], dependencies=ALERT_READ_ROLES)
def list_alerts(
    agency_id: str,
    alert_type: str | None = Query(default=None, min_length=1, max_length=80),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AlertResponse]:
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")

    query = (
        select(Alert)
        .options(joinedload(Alert.camera), joinedload(Alert.device))
        .where(Alert.agency_id == agency_id)
        .order_by(desc(Alert.created_at))
    )
    if alert_type is not None:
        query = query.where(Alert.alert_type == alert_type)

    alerts = db.scalars(query).unique().all()
    return [to_response(alert) for alert in alerts]


def to_response(alert: Alert) -> AlertResponse:
    return AlertResponse(
        id=alert.id,
        agency_id=alert.agency_id,
        camera_id=alert.camera_id,
        camera_name=alert.camera.name if alert.camera is not None else None,
        device_id=alert.device_id,
        device_name=alert.device.name if alert.device is not None else None,
        alert_type=alert.alert_type,
        title=alert.title,
        message=alert.message,
        severity=alert.severity,
        status=alert.status,
        created_at=alert.created_at,
        resolved_at=alert.resolved_at,
        tracking_id=alert.tracking_id,
    )


@actions_router.post(
    "/{alert_id}/acknowledge", response_model=AlertResponse, dependencies=ALERT_READ_ROLES
)
def acknowledge_alert(
    alert_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AlertResponse:
    """Someone has seen it and is dealing with it. The alert stays active (a
    sensor still over its limit keeps it, and it resolves on its own when the
    cause clears), but it stops counting as unseen. Acknowledging a resolved
    alert changes nothing."""
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerte introuvable")
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != alert.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    if alert.status == AlertStatus.OPEN:
        alert.status = AlertStatus.ACKNOWLEDGED
        db.commit()
        db.refresh(alert)
    return to_response(alert)


@actions_router.post(
    "/{alert_id}/resolve", response_model=AlertResponse, dependencies=ALERT_READ_ROLES
)
def resolve_alert(
    alert_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AlertResponse:
    """A person closes the incident. Weapon and watchlist alerts are only ever
    closed this way (app/ai_alerts/incidents.py); a sensor alert closed while
    its value is still over the limit simply reopens on the next reading."""
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerte introuvable")
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != alert.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    if alert.status != AlertStatus.RESOLVED:
        alert.status = AlertStatus.RESOLVED
        alert.resolved_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(alert)
    return to_response(alert)


class ItsStaff(BaseModel):
    employee_id: str


@actions_router.post(
    "/{alert_id}/its-staff", response_model=AlertResponse, dependencies=ALERT_READ_ROLES
)
def intrusion_is_staff(
    alert_id: str,
    payload: ItsStaff,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AlertResponse:
    """A false intrusion alarm: the "unknown" person is this employee (the
    tracker lost them). Links the tracked person to the employee, so the
    watch stops flagging them, and closes the alert."""
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerte introuvable")
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != alert.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    if alert.alert_type != INTRUSION or not alert.tracking_id:
        raise HTTPException(status_code=422, detail="Pas une alerte d'intrusion")
    employee = db.get(Employee, payload.employee_id)
    if employee is None or employee.agency_id != alert.agency_id:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    if not employee.is_active or employee.status.value != "ACTIVE":
        raise HTTPException(status_code=422, detail="Employe inactif")

    link_track(db, employee, alert.tracking_id, current_user)
    if alert.status != AlertStatus.RESOLVED:
        alert.status = AlertStatus.RESOLVED
        alert.resolved_at = datetime.now(timezone.utc)
        alert.message = (
            f"{alert.message} - fausse alerte: {employee.first_name} {employee.last_name} (personnel)"
        )
    db.commit()
    db.refresh(alert)
    return to_response(alert)
