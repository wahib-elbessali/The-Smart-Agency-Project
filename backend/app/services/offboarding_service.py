"""Offboarding cascade for an employee who leaves.

RFID and door access already check Employee.is_active live on every swipe, so
those need nothing here. What did not exist: an INACTIVE (or deleted) employee
kept their dashboard login and their entry in the AI face gallery.

Two parts with different shapes on purpose:

- disable_linked_login runs inside the caller's transaction, so the login is
  dead the moment the status change commits. (get_current_user, login and
  refresh all re-check User.is_active against the database, so there is no
  leftover window where an already-issued token keeps working.)
- remove_face_for runs as a background task. It calls the AI service, which
  must never slow down or fail a status change.

The face gallery is keyed by a free-text name with no link back to an
Employee, so removal matches on the employee's full name. Because the gallery
is site-wide, a namesake in another branch is possible; deleting that person's
face would wrongly lock out someone still employed, so removal is skipped
whenever another non-INACTIVE employee shares the name.
"""

import logging
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.database.connection import SessionLocal
from app.models.entities import AuditLog, Employee, EmployeeStatus, User
from app.services.door_face import face_key


logger = logging.getLogger(__name__)


def normalise_name(*parts: str) -> str:
    return " ".join(" ".join(parts).casefold().split())


def name_keys(first_name: str, last_name: str) -> set[str]:
    return {normalise_name(first_name, last_name), normalise_name(last_name, first_name)}


def disable_linked_login(db: Session, employee: Employee) -> bool:
    """Deactivate the linked User and release their counter, and drop the
    employee's link to a tracked person (an offboarded employee must not
    count as staff in a restricted zone, or be named on the live map). True
    if there was a login to disable. Does not commit - the caller's
    transaction does."""
    employee.tracking_id = None
    user = db.get(User, employee.user_id) if employee.user_id else None
    if user is None:
        return False
    user.is_active = False
    user.counter_id = None
    return True


def remove_face_for(
    employee_id: str,
    first_name: str,
    last_name: str,
    actor_user_id: str | None,
    agency_id: str,
) -> None:
    """Background task. Takes plain values, not the ORM row: on a delete the
    row is already gone by the time this runs. Never raises."""
    db = SessionLocal()
    try:
        keys = name_keys(first_name, last_name)

        namesakes = db.scalars(
            select(Employee).where(
                Employee.id != employee_id,
                Employee.status != EmployeeStatus.INACTIVE,
            )
        ).all()
        if any(name_keys(e.first_name, e.last_name) & keys for e in namesakes):
            logger.warning(
                "offboarding: face for %s %s kept - another active employee shares the name",
                first_name,
                last_name,
            )
            _audit(db, actor_user_id, agency_id, employee_id, {"removed": [], "skipped": "namesake"})
            return

        response = forward("GET", "/face/faces")
        raise_for_ai_status(response)
        gallery = [entry["name"] for entry in response.json()]
        # The employee's own face key (badge + face doors), plus any legacy
        # entry enrolled under their name.
        matches = [
            name
            for name in gallery
            if name == face_key(employee_id) or normalise_name(name) in keys
        ]

        removed = []
        for name in matches:
            deleted = forward("DELETE", f"/face/faces/{quote(name, safe='')}")
            raise_for_ai_status(deleted)
            removed.append(name)

        _audit(db, actor_user_id, agency_id, employee_id, {"removed": removed})
    except Exception:
        db.rollback()
        logger.exception("offboarding: could not remove face for employee %s", employee_id)
    finally:
        db.close()


def _audit(
    db: Session, actor_user_id: str | None, agency_id: str, employee_id: str, details: dict
) -> None:
    db.add(
        AuditLog(
            user_id=actor_user_id,
            agency_id=agency_id,
            action="employee_face_removed",
            entity_type="employee",
            entity_id=employee_id,
            details=details,
        )
    )
    db.commit()
