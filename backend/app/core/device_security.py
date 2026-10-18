import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Device, DeviceStatus


def generate_device_key() -> str:
    return secrets.token_urlsafe(32)


def hash_device_key(device_key: str) -> str:
    return hashlib.sha256(device_key.encode("utf-8")).hexdigest()


def authenticate_ingestion_device(
    agency_id: str,
    device_id: str,
    device_key: str | None,
    db: Session,
) -> Device:
    if not device_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Device-Key est obligatoire",
        )

    device = db.scalar(
        select(Device).where(
            Device.agency_id == agency_id,
            Device.mqtt_client_id == device_id,
        )
    )
    if device is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable dans cette agence")
    if device.device_key_hash is None or not hmac.compare_digest(
        device.device_key_hash,
        hash_device_key(device_key),
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Clé appareil invalide")

    device.last_seen_at = datetime.now(timezone.utc)
    device.status = DeviceStatus.ONLINE
    db.commit()
    db.refresh(device)
    return device
