from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.security import require_roles
from app.database.connection import get_db
from app.models.entities import (
    Agency,
    Alert,
    AlertStatus,
    Attendance,
    Counter,
    Employee,
    Role,
    RoleName,
    User,
)
from app.schemas.assignment import (
    AgentAssignmentResponse,
    AgentAttendance,
    AgentAssignmentUpdate,
    AgentSummaryResponse,
)


router = APIRouter(tags=["Agent assignments"])


def assignment_query():
    return selectinload(User.assigned_counter).selectinload(Counter.service)


def no_show_wait_for(user: User) -> int:
    return user.agency.no_show_min_wait_seconds if user.agency else 60


def to_assignment(user: User) -> AgentAssignmentResponse | None:
    counter = user.assigned_counter
    service = counter.service if counter is not None else None
    if counter is None or service is None:
        return None
    return AgentAssignmentResponse(
        counter_id=counter.id,
        counter_name=counter.name,
        service_id=service.id,
        service_name=service.name,
        no_show_min_wait_seconds=no_show_wait_for(user),
    )


def attendance_for_agents(
    db: Session, agency_id: str, agents: list[User]
) -> dict[str, AgentAttendance]:
    """Today's badge state per agent user id, only for agents who have a linked
    Employee - the rest are simply absent from the result (no data is not a
    reason to flag anyone). "Today" is since UTC midnight, the same definition
    GET /attendance/today uses.

    While the MQTT broker is known to be down (Phase J's mqtt_down alert is
    open) RFID badge-ins cannot arrive, so every state is "unavailable"
    instead of a wave of false "not checked in" flags."""
    employees = db.scalars(
        select(Employee).where(Employee.user_id.in_([agent.id for agent in agents]))
    ).all()
    if not employees:
        return {}

    broker_down = (
        db.scalar(
            select(Alert.id).where(
                Alert.agency_id == agency_id,
                Alert.alert_type == "mqtt_down",
                Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
            )
        )
        is not None
    )
    if broker_down:
        return {e.user_id: AgentAttendance(state="unavailable") for e in employees}

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    latest: dict[str, Attendance] = {}
    for row in db.scalars(
        select(Attendance)
        .where(
            Attendance.employee_id.in_([e.id for e in employees]),
            Attendance.check_in >= today_start,
        )
        .order_by(Attendance.check_in)
    ):
        latest[row.employee_id] = row  # ascending, so the last write is the newest

    result: dict[str, AgentAttendance] = {}
    for employee in employees:
        row = latest.get(employee.id)
        if row is None:
            result[employee.user_id] = AgentAttendance(state="not_checked_in")
        elif row.check_out is None:
            result[employee.user_id] = AgentAttendance(state="checked_in", at=row.check_in)
        else:
            result[employee.user_id] = AgentAttendance(state="checked_out", at=row.check_out)
    return result


def get_agent_or_404(user_id: str, db: Session) -> User:
    user = db.scalar(
        select(User)
        .options(
            selectinload(User.role),
            selectinload(User.agency),
            assignment_query(),
        )
        .where(User.id == user_id)
    )
    if user is None:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    # A manager stepping in to help on a busy counter covers it like an agent
    # does (found in the 2026-10-18 day test: a manager could not be shown
    # as covering the second Virement counter).
    if user.role.name not in COVERING_ROLES:
        raise HTTPException(status_code=422, detail="L utilisateur doit avoir le role AGENT ou MANAGER")
    return user


COVERING_ROLES = (RoleName.AGENT, RoleName.MANAGER)


def ensure_manager_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name == RoleName.MANAGER and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


@router.get(
    "/agents/me/assignment",
    response_model=AgentAssignmentResponse | None,
    dependencies=[Depends(require_roles(RoleName.AGENT))],
)
def get_my_assignment(
    current_user: User = Depends(require_roles(RoleName.AGENT)),
    db: Session = Depends(get_db),
) -> AgentAssignmentResponse | None:
    user = get_agent_or_404(current_user.id, db)
    return to_assignment(user)


@router.get(
    "/agencies/{agency_id}/agents",
    response_model=list[AgentSummaryResponse],
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def list_agency_agents(
    agency_id: str,
    current_user: User = Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER)),
    db: Session = Depends(get_db),
) -> list[AgentSummaryResponse]:
    if db.get(Agency, agency_id) is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    ensure_manager_scope(agency_id, current_user)

    agents = db.scalars(
        select(User)
        .join(User.role)
        .options(assignment_query(), selectinload(User.agency))
        .where(
            User.agency_id == agency_id,
            Role.name.in_(COVERING_ROLES),
            User.is_active.is_(True),
        )
        .order_by(User.full_name)
    ).unique().all()
    attendance = attendance_for_agents(db, agency_id, list(agents))
    return [
        AgentSummaryResponse(
            user_id=agent.id,
            full_name=agent.full_name,
            role=agent.role.name.value,
            assignment=to_assignment(agent),
            attendance=attendance.get(agent.id),
        )
        for agent in agents
    ]


@router.patch(
    "/agents/{user_id}/assignment",
    response_model=AgentAssignmentResponse | None,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def update_agent_assignment(
    user_id: str,
    payload: AgentAssignmentUpdate,
    current_user: User = Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER)),
    db: Session = Depends(get_db),
) -> AgentAssignmentResponse | None:
    agent = get_agent_or_404(user_id, db)
    ensure_manager_scope(agent.agency_id, current_user)

    if payload.counter_id is None:
        agent.counter_id = None
        db.commit()
        return None

    counter = db.scalar(
        select(Counter)
        .options(selectinload(Counter.service))
        .where(Counter.id == payload.counter_id)
    )
    if counter is None:
        raise HTTPException(status_code=404, detail="Guichet ou bureau introuvable")
    if counter.agency_id != agent.agency_id:
        raise HTTPException(
            status_code=422,
            detail="L agent et le guichet doivent appartenir a la meme agence",
        )
    if counter.service is None:
        raise HTTPException(status_code=409, detail="Ce guichet n est affecte a aucun service")
    if not counter.service.is_active:
        raise HTTPException(status_code=409, detail="Le service du guichet est inactif")

    # Nothing enforced one counter having at most one
    # current agent - two agents could each set their own counter_id to the
    # same counter and neither assignment would ever be told about the
    # other. A counter is a single physical window; whoever was already
    # there is being relieved, not doubled up with, by this assignment.
    previous_agent = db.scalar(
        select(User).where(User.counter_id == counter.id, User.id != agent.id)
    )
    if previous_agent is not None:
        previous_agent.counter_id = None
        # Must land before the new agent's row is written below - the two
        # UPDATEs both touch this counter_id, and the partial unique index
        # is checked per-statement, not deferred to commit. Batched in the
        # same flush, SQLAlchemy is free to order them either way; caught
        # live testing this by getting a UniqueViolation on the exact
        # reassignment this code exists to allow.
        db.flush()

    agent.counter_id = counter.id
    db.commit()
    return AgentAssignmentResponse(
        counter_id=counter.id,
        counter_name=counter.name,
        service_id=counter.service.id,
        service_name=counter.service.name,
        no_show_min_wait_seconds=no_show_wait_for(agent),
    )
