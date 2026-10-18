"""Manual fixes to "who is this tracked person": the tracker links employees
to tracks on its own (a badge scan, app/services/people_tracking.py, and the
hand-off in zone_watch.py); these are for when it got one wrong. Every
decision goes to the audit log, so a link that let someone into a staff
zone can be traced to who made it."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import AuditLog, Employee, User


def link_track(db: Session, employee: Employee, tracking_id: str, by: User | None) -> None:
    """This tracked person is `employee`. A track is one person, so whoever
    else held it loses it."""
    for other in db.scalars(select(Employee).where(Employee.tracking_id == tracking_id)).all():
        if other.id != employee.id:
            other.tracking_id = None
    employee.tracking_id = tracking_id
    db.add(
        AuditLog(
            user_id=by.id if by else None,
            agency_id=employee.agency_id,
            action="track_linked",
            entity_type="employee",
            entity_id=employee.id,
            details={"tracking_id": tracking_id},
        )
    )


def unlink_track(db: Session, agency_id: str | None, tracking_id: str, by: User | None) -> int:
    """This tracked person is not staff. Returns how many links were removed
    (0 or 1 in practice). `agency_id` None = any branch (ADMIN)."""
    query = select(Employee).where(Employee.tracking_id == tracking_id)
    if agency_id is not None:
        query = query.where(Employee.agency_id == agency_id)
    employees = db.scalars(query).all()
    for employee in employees:
        employee.tracking_id = None
        db.add(
            AuditLog(
                user_id=by.id if by else None,
                agency_id=employee.agency_id,
                action="track_unlinked",
                entity_type="employee",
                entity_id=employee.id,
                details={"tracking_id": tracking_id},
            )
        )
    return len(employees)
