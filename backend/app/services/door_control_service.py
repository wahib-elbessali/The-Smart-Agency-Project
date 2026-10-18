"""Bulk door commands for automated responses.

Phase H uses it to lock an agency's doors on a confirmed weapon detection.
A "door device" is any Device whose device_type is DOOR or ACCESS_SENSORS
(case-insensitive). ACCESS_SENSORS is the shared ESP32 the hardware contract
puts the door servo on (contracts/ingestion.md, access-sensors-1); matching
DOOR alone meant no automated command ever reached a real door (2026-10-18
day test: a CRITICAL gas alert unlocked nothing). device_type is free text
with no enum behind it, and doors stay plain devices, never tied to zones or
cameras.

Fire-and-forget on purpose, the same as every automated command in the app
(iot_service's alert/climate commands): no human is watching a spinner, so
the blocking ack-correlated path ManualControls uses is the wrong tool.
Whether each publish was accepted is recorded in the audit log; whether the
lock physically engaged is not knowable from here.

Never raises - a broker outage must not stop the alert pipeline that called
this.
"""

import logging
import uuid

from sqlalchemy import func, select

from app.database.connection import SessionLocal
from app.models.entities import AuditLog, Device
from app.mqtt.topics import CONTROL_COMMAND_TOPIC


logger = logging.getLogger(__name__)

DOOR_DEVICE_TYPES = ("DOOR", "ACCESS_SENSORS")


def send_door_command(
    agency_id: str, action: str, *, reason: str, details: dict | None = None
) -> list[dict]:
    """Send `action` to every door device of the agency and audit it once.
    Returns [{device_id, name, published}]; empty if the agency has no doors."""
    # Imported here: iot_service (which sensor_consumer imports) calls this module.
    from app.mqtt.sensor_consumer import sensor_consumer

    db = SessionLocal()
    try:
        doors = db.scalars(
            select(Device).where(
                Device.agency_id == agency_id,
                func.upper(Device.device_type).in_(DOOR_DEVICE_TYPES),
            )
        ).all()
        results = []
        for door in doors:
            topic = CONTROL_COMMAND_TOPIC.format(
                agency_id=agency_id, device_id=door.mqtt_client_id
            )
            published = sensor_consumer.publish_command(
                topic,
                {"correlation_id": uuid.uuid4().hex, "action": action, "target": None},
            )
            results.append({"device_id": door.id, "name": door.name, "published": published})
        db.add(
            AuditLog(
                user_id=None,
                agency_id=agency_id,
                action=f"auto_{action}_command",
                entity_type="agency",
                entity_id=agency_id,
                details={"reason": reason, "doors": results, **(details or {})},
            )
        )
        db.commit()
        if not results:
            logger.warning("auto %s for agency %s: no door devices registered", action, agency_id)
        return results
    except Exception:
        db.rollback()
        logger.exception("auto %s for agency %s failed", action, agency_id)
        return []
    finally:
        db.close()
