from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, select
from sqlalchemy.orm import Session, selectinload

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Attendance, AttendanceMethod, Employee, RoleName, User
from app.schemas.attendance import AttendanceEventRequest, AttendanceResponse
from app.services.attendance_service import (
    attendance_to_dict,
    record_check_in,
    record_check_out,
)
from app.websocket.manager import attendance_manager


router = APIRouter(prefix="/attendance", tags=["Attendance"])
ATTENDANCE_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))
]


def ensure_access(employee: Employee, current_user: User) -> None:
    if current_user.role.name in (RoleName.MANAGER, RoleName.SECURITY):
        if employee.agency_id != current_user.agency_id:
            raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def response_from_attendance(attendance: Attendance) -> AttendanceResponse:
    data = attendance_to_dict(attendance)
    return AttendanceResponse(**data)


@router.post("/check-in", response_model=AttendanceResponse, dependencies=ATTENDANCE_ROLES)
async def check_in(
    payload: AttendanceEventRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AttendanceResponse:
    employee = db.scalar(select(Employee).where(Employee.rfid_uid == payload.employee_rfid))
    if employee is None:
        raise HTTPException(status_code=404, detail="Carte RFID ou employe introuvable")
    ensure_access(employee, current_user)
    attendance = record_check_in(db, payload.employee_rfid, payload.timestamp, employee.agency_id)
    await attendance_manager.broadcast({"type": "attendance_updated", "event": "check_in", **attendance_to_dict(attendance)})
    return response_from_attendance(attendance)


@router.post("/check-out", response_model=AttendanceResponse, dependencies=ATTENDANCE_ROLES)
async def check_out(
    payload: AttendanceEventRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AttendanceResponse:
    employee = db.scalar(select(Employee).where(Employee.rfid_uid == payload.employee_rfid))
    if employee is None:
        raise HTTPException(status_code=404, detail="Carte RFID ou employe introuvable")
    ensure_access(employee, current_user)
    attendance = record_check_out(db, payload.employee_rfid, payload.timestamp, employee.agency_id)
    await attendance_manager.broadcast({"type": "attendance_updated", "event": "check_out", **attendance_to_dict(attendance)})
    return response_from_attendance(attendance)


@router.get("/today", response_model=list[AttendanceResponse], dependencies=ATTENDANCE_ROLES)
def today(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AttendanceResponse]:
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    query = (
        select(Attendance)
        .join(Attendance.employee)
        .options(selectinload(Attendance.employee))
        .where(Attendance.check_in >= today_start)
        .order_by(Attendance.check_in.desc())
    )
    if current_user.role.name in (RoleName.MANAGER, RoleName.SECURITY):
        query = query.where(Employee.agency_id == current_user.agency_id)
    return [response_from_attendance(item) for item in db.scalars(query).all()]


@router.get("/employee/{employee_id}", response_model=list[AttendanceResponse], dependencies=ATTENDANCE_ROLES)
def employee_attendance(
    employee_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AttendanceResponse]:
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    ensure_access(employee, current_user)
    query = (
        select(Attendance)
        .where(Attendance.employee_id == employee_id)
        .options(selectinload(Attendance.employee))
        .order_by(Attendance.check_in.desc())
    )
    return [response_from_attendance(item) for item in db.scalars(query).all()]
