from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import AuditLog, Agency, Employee, EmployeeStatus, RoleName, User, Zone
from app.services.offboarding_service import disable_linked_login, remove_face_for
from app.services.track_links import link_track, unlink_track
from app.schemas.employee import (
    EmployeeCreate,
    EmployeeResponse,
    EmployeeUpdate,
    TrackedEmployeeResponse,
)


router = APIRouter(prefix="/employees", tags=["Employees"])


def normalize_status(value: str) -> EmployeeStatus:
    try:
        return EmployeeStatus(value.upper())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="Statut invalide. Valeurs: ACTIVE, INACTIVE, ON_LEAVE",
        ) from exc


def normalize_role(value: str) -> RoleName:
    try:
        return RoleName(value.strip().upper())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="Role invalide. Valeurs: ADMIN, MANAGER, AGENT, SECURITY, TECHNICIAN",
        ) from exc


def zones_for_employee(agency_id: str, zone_ids: list[str], db: Session) -> list[Zone]:
    unique_zone_ids = list(dict.fromkeys(zone_ids))
    zones = [db.get(Zone, zone_id) for zone_id in unique_zone_ids]
    if any(zone is None for zone in zones):
        raise HTTPException(status_code=404, detail="Zone introuvable")
    if any(zone.agency_id != agency_id for zone in zones):
        raise HTTPException(status_code=422, detail="Une zone doit appartenir a la meme agence")
    return zones


def get_accessible_employee(employee_id: str, current_user: User, db: Session) -> Employee:
    employee = db.scalar(
        select(Employee)
        .options(selectinload(Employee.authorized_zones))
        .where(Employee.id == employee_id)
    )
    if employee is None:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    if current_user.role.name == RoleName.MANAGER and employee.agency_id != current_user.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    return employee


def to_response(employee: Employee) -> EmployeeResponse:
    return EmployeeResponse(
        id=employee.id,
        agency_id=employee.agency_id,
        first_name=employee.first_name,
        last_name=employee.last_name,
        email=employee.email,
        phone=employee.phone,
        position=employee.position,
        rfid_uid=employee.rfid_uid,
        role=employee.role.value,
        authorized_zone_ids=employee.authorized_zone_ids,
        status=employee.status.value,
        hire_date=employee.hire_date,
        is_active=employee.is_active,
    )


@router.get(
    "",
    response_model=list[EmployeeResponse],
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def list_employees(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[EmployeeResponse]:
    query = (
        select(Employee)
        .options(selectinload(Employee.authorized_zones))
        .order_by(Employee.last_name, Employee.first_name)
    )
    if current_user.role.name == RoleName.MANAGER:
        query = query.where(Employee.agency_id == current_user.agency_id)
    return [to_response(employee) for employee in db.scalars(query).all()]


@router.get(
    "/tracked",
    response_model=list[TrackedEmployeeResponse],
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))],
)
def list_tracked_employees(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TrackedEmployeeResponse]:
    """For the live map (Tracking.tsx) to relabel a tracked person by
    employee name - same roles as /tracking itself and /tickets/tracked, a
    monitoring read, not the ADMIN/MANAGER-only management roles every
    other route in this router uses. Registered BEFORE GET /{employee_id}
    below - this router matches by registration order, and that route
    would otherwise capture the literal path segment "tracked" as an id."""
    query = select(Employee).where(
        Employee.tracking_id.is_not(None),
        Employee.is_active.is_(True),
        Employee.status == EmployeeStatus.ACTIVE,
    )
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Employee.agency_id == current_user.agency_id)
    return [
        TrackedEmployeeResponse(
            employee_id=employee.id,
            full_name=f"{employee.first_name} {employee.last_name}",
            tracking_id=employee.tracking_id,
        )
        for employee in db.scalars(query).all()
    ]


TRACK_FIX_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]


class TrackLink(BaseModel):
    tracking_id: str = Field(min_length=1, max_length=50)


@router.get("/roster", dependencies=TRACK_FIX_ROLES)
def list_roster(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """Active employees' names, for picking who a tracked person is (live
    map, an intrusion alert's "It's staff"). SECURITY may read this, unlike
    the full employee list. Registered before GET /{employee_id}."""
    query = select(Employee).where(Employee.status == EmployeeStatus.ACTIVE)
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Employee.agency_id == current_user.agency_id)
    return [
        {"employee_id": e.id, "full_name": f"{e.first_name} {e.last_name}", "agency_id": e.agency_id}
        for e in db.scalars(query.order_by(Employee.first_name, Employee.last_name)).all()
    ]


@router.put("/{employee_id}/tracking", status_code=204, dependencies=TRACK_FIX_ROLES)
def link_employee_track(
    employee_id: str,
    payload: TrackLink,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The live map's manual fix: this tracked person is this employee.
    Used when the tracker lost someone and picked them up as a stranger."""
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    if current_user.role.name != RoleName.ADMIN and employee.agency_id != current_user.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    if not employee.is_active or employee.status != EmployeeStatus.ACTIVE:
        raise HTTPException(status_code=422, detail="Employe inactif")
    link_track(db, employee, payload.tracking_id, current_user)
    db.commit()
    return Response(status_code=204)


@router.delete("/tracked/{tracking_id}", status_code=204, dependencies=TRACK_FIX_ROLES)
def unlink_track_route(
    tracking_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The other manual fix: this tracked person is not staff (a wrong link,
    e.g. two people at the gate at once)."""
    agency_id = None if current_user.role.name == RoleName.ADMIN else current_user.agency_id
    unlink_track(db, agency_id, tracking_id, current_user)
    db.commit()
    return Response(status_code=204)


@router.post(
    "",
    response_model=EmployeeResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def create_employee(
    payload: EmployeeCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EmployeeResponse:
    agency_id = payload.agency_id
    if current_user.role.name == RoleName.MANAGER:
        agency_id = current_user.agency_id
    if agency_id is None:
        raise HTTPException(status_code=422, detail="agency_id est obligatoire pour un ADMIN")
    if db.get(Agency, agency_id) is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")

    authorized_zones = zones_for_employee(agency_id, payload.authorized_zone_ids, db)
    employee = Employee(
        agency_id=agency_id,
        first_name=payload.first_name.strip(),
        last_name=payload.last_name.strip(),
        email=payload.email.strip().lower() if payload.email else None,
        phone=payload.phone,
        position=payload.position,
        rfid_uid=payload.rfid_uid,
        role=normalize_role(payload.role),
        authorized_zones=authorized_zones,
        status=normalize_status(payload.status),
        hire_date=payload.hire_date,
        is_active=payload.status.upper() == EmployeeStatus.ACTIVE.value,
    )
    db.add(employee)
    try:
        db.commit()
        db.refresh(employee)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email ou carte RFID deja utilise") from exc
    return to_response(employee)


@router.get(
    "/{employee_id}",
    response_model=EmployeeResponse,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def get_employee(
    employee_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EmployeeResponse:
    return to_response(get_accessible_employee(employee_id, current_user, db))


@router.put(
    "/{employee_id}",
    response_model=EmployeeResponse,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def update_employee(
    employee_id: str,
    payload: EmployeeUpdate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EmployeeResponse:
    employee = get_accessible_employee(employee_id, current_user, db)
    changes = payload.model_dump(exclude_unset=True)
    was_inactive = employee.status == EmployeeStatus.INACTIVE

    if current_user.role.name == RoleName.MANAGER and "agency_id" in changes:
        if changes["agency_id"] != current_user.agency_id:
            raise HTTPException(status_code=403, detail="Un manager ne peut pas changer d agence")

    if "agency_id" in changes and changes["agency_id"] is not None:
        if db.get(Agency, changes["agency_id"]) is None:
            raise HTTPException(status_code=404, detail="Agence introuvable")
    if "status" in changes and changes["status"] is not None:
        changes["status"] = normalize_status(changes["status"])
        changes["is_active"] = changes["status"] == EmployeeStatus.ACTIVE
    if "role" in changes and changes["role"] is not None:
        changes["role"] = normalize_role(changes["role"])
    authorized_zone_ids = changes.pop("authorized_zone_ids", None)
    target_agency_id = changes.get("agency_id", employee.agency_id)
    if target_agency_id is None:
        raise HTTPException(status_code=422, detail="agency_id est obligatoire")
    if authorized_zone_ids is not None:
        employee.authorized_zones = zones_for_employee(target_agency_id, authorized_zone_ids, db)
    elif "agency_id" in changes and target_agency_id != employee.agency_id:
        employee.authorized_zones = []
    if "email" in changes and changes["email"]:
        changes["email"] = changes["email"].strip().lower()

    for field, value in changes.items():
        setattr(employee, field, value.strip() if isinstance(value, str) else value)

    # Leaving the company (not just ON_LEAVE): the login dies in this same
    # transaction, the face-gallery entry is removed afterwards.
    offboarding = employee.status == EmployeeStatus.INACTIVE and not was_inactive
    if offboarding:
        login_disabled = disable_linked_login(db, employee)
        db.add(
            AuditLog(
                user_id=current_user.id,
                agency_id=employee.agency_id,
                action="employee_offboarded",
                entity_type="employee",
                entity_id=employee.id,
                details={"login_disabled": login_disabled, "trigger": "status_inactive"},
            )
        )

    try:
        db.commit()
        db.refresh(employee)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email ou carte RFID deja utilise") from exc
    if offboarding:
        background_tasks.add_task(
            remove_face_for,
            employee.id,
            employee.first_name,
            employee.last_name,
            current_user.id,
            employee.agency_id,
        )
    return to_response(employee)


@router.delete(
    "/{employee_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def delete_employee(
    employee_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    employee = get_accessible_employee(employee_id, current_user, db)
    # Deleting an employee used to leave the linked login active - same gap as
    # going INACTIVE, same cascade. Values are captured first: the row is gone
    # by the time the background task runs.
    login_disabled = disable_linked_login(db, employee)
    first_name, last_name, agency_id = employee.first_name, employee.last_name, employee.agency_id
    db.add(
        AuditLog(
            user_id=current_user.id,
            agency_id=agency_id,
            action="employee_offboarded",
            entity_type="employee",
            entity_id=employee.id,
            details={"login_disabled": login_disabled, "trigger": "deleted"},
        )
    )
    db.delete(employee)
    db.commit()
    background_tasks.add_task(
        remove_face_for, employee_id, first_name, last_name, current_user.id, agency_id
    )
