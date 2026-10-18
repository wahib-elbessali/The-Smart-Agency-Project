from sqlalchemy import func, select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends

from app.api.devices import ensure_agency_scope, get_agency_or_404
from app.core.security import get_current_user
from app.database.connection import get_db
from app.models.entities import Device, SensorReading, User
from app.schemas.sensor import LatestReading


router = APIRouter(prefix="/agencies", tags=["Climate"])

# No role restriction, unlike thresholds/devices - matches the frontend's own
# access.ts, which has no entry for /climate at all (open to every
# authenticated role, same as the outdoor-weather half of that screen).
# Still agency-scoped for a non-ADMIN, same as everything else here.


@router.get("/{agency_id}/climate/latest", response_model=list[LatestReading])
def get_latest_climate(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[LatestReading]:
    """The most recent reading per (device, sensor_type) for this agency's
    devices - temperature/humidity from the DHT22, whatever else a device
    reports. Ingestion (process_sensor_payload) already writes every
    reading to `sensor_readings`; nothing anywhere read it back out before
    this, the Climate screen only ever showed outdoor Open-Meteo data."""
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)

    # One row per (device_id, sensor_type) at its own MAX(recorded_at) -
    # a device can report several sensor types, each on its own cadence,
    # so a single "latest row overall" would silently drop the others.
    latest_per_pair = (
        select(
            SensorReading.device_id,
            SensorReading.sensor_type,
            func.max(SensorReading.recorded_at).label("recorded_at"),
        )
        .join(Device, Device.id == SensorReading.device_id)
        .where(Device.agency_id == agency_id)
        .group_by(SensorReading.device_id, SensorReading.sensor_type)
        .subquery()
    )

    rows = db.execute(
        select(SensorReading, Device.name)
        .join(Device, Device.id == SensorReading.device_id)
        .join(
            latest_per_pair,
            (SensorReading.device_id == latest_per_pair.c.device_id)
            & (SensorReading.sensor_type == latest_per_pair.c.sensor_type)
            & (SensorReading.recorded_at == latest_per_pair.c.recorded_at),
        )
        .order_by(Device.name, SensorReading.sensor_type)
    ).all()

    return [
        LatestReading(
            device_id=reading.device_id,
            device_name=device_name,
            sensor_type=reading.sensor_type,
            value=reading.value,
            unit=reading.unit,
            recorded_at=reading.recorded_at,
        )
        for reading, device_name in rows
    ]
