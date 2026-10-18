from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Attendance, AttendanceMethod, Employee


def event_time(value: datetime | None) -> datetime:
    return value or datetime.now(timezone.utc)


def find_employee_by_rfid(db: Session, employee_rfid: str, agency_id: str | None = None) -> Employee:
    query = select(Employee).where(
        Employee.rfid_uid == employee_rfid,
        Employee.is_active.is_(True),
    )
    if agency_id is not None:
        query = query.where(Employee.agency_id == agency_id)
    employee = db.scalar(query)
    if employee is None:
        raise HTTPException(status_code=404, detail="Carte RFID ou employe introuvable")
    return employee


def record_check_in(
    db: Session,
    employee_rfid: str,
    timestamp: datetime | None = None,
    agency_id: str | None = None,
) -> Attendance:
    employee = find_employee_by_rfid(db, employee_rfid, agency_id)
    open_attendance = db.scalar(
        select(Attendance).where(
            Attendance.employee_id == employee.id,
            Attendance.check_out.is_(None),
        )
    )
    if open_attendance is not None:
        return open_attendance

    attendance = Attendance(
        employee_id=employee.id,
        check_in=event_time(timestamp),
        method=AttendanceMethod.RFID,
    )
    db.add(attendance)
    db.commit()
    db.refresh(attendance)
    return attendance


def record_check_out(
    db: Session,
    employee_rfid: str,
    timestamp: datetime | None = None,
    agency_id: str | None = None,
) -> Attendance:
    employee = find_employee_by_rfid(db, employee_rfid, agency_id)
    attendance = db.scalar(
        select(Attendance)
        .where(
            Attendance.employee_id == employee.id,
            Attendance.check_out.is_(None),
        )
        .order_by(Attendance.check_in.desc())
    )
    if attendance is None:
        raise HTTPException(status_code=409, detail="Aucune presence ouverte pour cet employe")

    attendance.check_out = event_time(timestamp)
    db.commit()
    db.refresh(attendance)
    return attendance


def record_rfid_event(
    db: Session,
    employee_rfid: str,
    timestamp: datetime | None = None,
    agency_id: str | None = None,
) -> tuple[Attendance, str]:
    """Toggle attendance from one RFID scan.

    The hardware only identifies the card. The backend treats a scan with no
    open attendance as check-in, and a scan with an open attendance as
    check-out. The returned event is the decision made by the backend.
    """
    employee = find_employee_by_rfid(db, employee_rfid, agency_id)
    open_attendance = db.scalar(
        select(Attendance)
        .where(
            Attendance.employee_id == employee.id,
            Attendance.check_out.is_(None),
        )
        .order_by(Attendance.check_in.desc())
    )

    if open_attendance is not None:
        open_attendance.check_out = event_time(timestamp)
        db.commit()
        db.refresh(open_attendance)
        return open_attendance, "check_out"

    attendance = Attendance(
        employee_id=employee.id,
        check_in=event_time(timestamp),
        method=AttendanceMethod.RFID,
    )
    db.add(attendance)
    db.commit()
    db.refresh(attendance)
    return attendance, "check_in"


def attendance_to_dict(attendance: Attendance) -> dict:
    return {
        "id": attendance.id,
        "employee_id": attendance.employee_id,
        "employee_name": f"{attendance.employee.first_name} {attendance.employee.last_name}",
        "agency_id": attendance.employee.agency_id,
        "check_in": attendance.check_in.isoformat(),
        "check_out": attendance.check_out.isoformat() if attendance.check_out else None,
        "method": attendance.method.value,
    }
