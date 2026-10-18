"""Failed RFID / door attempts.

Until now a failed check-rfid or door-access left no trace anywhere - AuditLog
only covers dashboard users - so a flaky reader misreading a valid card, a
card physically wearing out, and someone testing random cards at a door could
not be told apart and were all invisible.

Only attempts from an AUTHENTICATED device are logged: a request with a bad
device key never reaches the handler, and giving unauthenticated callers a way
to write rows here would be a flood vector.

Runs as a background task with its own session, like every other side effect on
these hot paths, so a denial is never delayed by a log write. Never raises.
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import AccessFailure, Employee


logger = logging.getLogger(__name__)

RETENTION_DAYS = 90


def log_access_failure(
    agency_id: str,
    device_id: str,
    scanned_uid: str,
    source: str,
    reason: str,
    zone_id: str | None = None,
    employee_id: str | None = None,
) -> None:
    """`device_id` is the Device primary key (not the mqtt_client_id). A card
    that nothing recognised is refined to employee_inactive when it does belong
    to an inactive employee - the hot-path lookups treat both as "not found"."""
    db = SessionLocal()
    try:
        if reason == "unknown_card" and employee_id is None:
            known = db.scalar(
                select(Employee).where(
                    Employee.rfid_uid == scanned_uid, Employee.agency_id == agency_id
                )
            )
            if known is not None:
                employee_id = known.id
                if not known.is_active:
                    reason = "employee_inactive"
        db.add(
            AccessFailure(
                agency_id=agency_id,
                device_id=device_id,
                scanned_uid=scanned_uid[:100],
                employee_id=employee_id,
                zone_id=zone_id,
                source=source,
                reason=reason,
                occurred_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("could not log access failure for device %s", device_id)
    finally:
        db.close()


def prune_access_failures() -> None:
    """Called from the health monitor's slow tick. Never raises."""
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
        db.execute(delete(AccessFailure).where(AccessFailure.occurred_at < cutoff))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("could not prune access failures")
    finally:
        db.close()
