from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.devices import ensure_agency_scope, get_device_or_404
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import RoleName, SensorThreshold, User
from app.schemas.threshold import SensorThresholdResponse, SensorThresholdUpsert


router = APIRouter(prefix="/devices", tags=["Sensor thresholds"])
THRESHOLD_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.TECHNICIAN))]


def normalize_sensor_type(sensor_type: str) -> str:
    normalized = sensor_type.strip().lower()
    if not normalized or len(normalized) > 80:
        raise HTTPException(status_code=422, detail="Type de capteur invalide")
    return normalized


@router.get(
    "/{device_id}/thresholds",
    response_model=list[SensorThresholdResponse],
    dependencies=THRESHOLD_ROLES,
)
def list_thresholds(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SensorThresholdResponse]:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    query = select(SensorThreshold).where(SensorThreshold.device_id == device.id).order_by(SensorThreshold.sensor_type)
    return list(db.scalars(query).all())


@router.put(
    "/{device_id}/thresholds/{sensor_type}",
    response_model=SensorThresholdResponse,
    dependencies=THRESHOLD_ROLES,
)
def upsert_threshold(
    device_id: str,
    sensor_type: str,
    payload: SensorThresholdUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SensorThresholdResponse:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    sensor_type = normalize_sensor_type(sensor_type)
    threshold = db.scalar(
        select(SensorThreshold).where(
            SensorThreshold.device_id == device.id,
            SensorThreshold.sensor_type == sensor_type,
        )
    )
    if threshold is None:
        threshold = SensorThreshold(device_id=device.id, sensor_type=sensor_type)
        db.add(threshold)

    for field, value in payload.model_dump().items():
        setattr(threshold, field, value.strip() if isinstance(value, str) else value)
    db.commit()
    db.refresh(threshold)
    return threshold


@router.delete(
    "/{device_id}/thresholds/{sensor_type}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=THRESHOLD_ROLES,
)
def delete_threshold(
    device_id: str,
    sensor_type: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    threshold = db.scalar(
        select(SensorThreshold).where(
            SensorThreshold.device_id == device.id,
            SensorThreshold.sensor_type == normalize_sensor_type(sensor_type),
        )
    )
    if threshold is None:
        raise HTTPException(status_code=404, detail="Seuil introuvable")
    db.delete(threshold)
    db.commit()
