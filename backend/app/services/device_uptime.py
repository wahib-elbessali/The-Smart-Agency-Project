"""Device uptime history.

Two facts shaped this:

- Device.status was only ever set to ONLINE (on a sensor message or an
  authenticated ingestion call) and never back to OFFLINE, so a dead sensor
  showed ONLINE forever. It cannot be sampled as-is.
- Silence only means something for a periodic publisher. A badge reader or a
  kiosk talks when something happens, so a quiet night is not an outage. A
  device is therefore tracked only if a manager gave it a heartbeat_seconds;
  everything else is left alone rather than guessed at.

A tracked device counts as online when it was heard from within
`device_missed_heartbeats` heartbeats. The sampler records that state for each
tracked device, and also corrects Device.status for them (ONLINE <-> OFFLINE;
ERROR and MAINTENANCE are someone's explicit call and are left alone) so the
Devices screen stops showing dead sensors as online.
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import Device, DeviceStatus, DeviceStatusSample


logger = logging.getLogger(__name__)


def is_online(device: Device, now: datetime) -> bool:
    if device.heartbeat_seconds is None or device.last_seen_at is None:
        return False
    allowed = timedelta(seconds=device.heartbeat_seconds * settings.device_missed_heartbeats)
    return now - device.last_seen_at <= allowed


def record_device_samples(db: Session, now: datetime) -> int:
    """One sample per tracked device, plus status correction and pruning.
    Returns how many samples were written. Commits."""
    devices = db.scalars(select(Device).where(Device.heartbeat_seconds.is_not(None))).all()
    for device in devices:
        online = is_online(device, now)
        db.add(DeviceStatusSample(device_id=device.id, sampled_at=now, online=online))
        if device.status in (DeviceStatus.ONLINE, DeviceStatus.OFFLINE):
            device.status = DeviceStatus.ONLINE if online else DeviceStatus.OFFLINE

    cutoff = now - timedelta(days=settings.device_sample_retention_days)
    db.execute(delete(DeviceStatusSample).where(DeviceStatusSample.sampled_at < cutoff))
    db.commit()
    return len(devices)


def sample_devices() -> None:
    """Entry point for the health monitor's thread. Never raises."""
    db = SessionLocal()
    try:
        record_device_samples(db, datetime.now(timezone.utc))
    except Exception:
        db.rollback()
        logger.exception("device uptime sampling failed")
    finally:
        db.close()
