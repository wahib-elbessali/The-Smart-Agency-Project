from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Camera, Counter, RoleName, Ticket, TicketStatus, User
from app.schemas.agency import CounterCreate, CounterResponse, CounterUpdate


router = APIRouter(tags=["Counters"])
COUNTER_READ_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.AGENT))]
COUNTER_WRITE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]

# UX_AUDIT.md finding 4. Before this file, a Counter row was writable exactly
# once: inside POST /agencies, at the moment a branch was first created
# (AgencyCreate.counters). There was no route to add a 5th window, rename
# one, or close it once the branch existed - confirmed by grepping every
# router for "/counters" before writing this one. `PATCH /counters/{id}/service`
# already existed (services.py, reassigns which service a counter serves) and
# is left untouched; this file is everything else a counter needs.


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def get_agency_or_404(agency_id: str, db: Session) -> Agency:
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    return agency


def get_counter_or_404(counter_id: str, db: Session) -> Counter:
    counter = db.get(Counter, counter_id)
    if counter is None:
        raise HTTPException(status_code=404, detail="Guichet ou bureau introuvable")
    return counter


@router.get(
    "/agencies/{agency_id}/counters",
    response_model=list[CounterResponse],
    dependencies=COUNTER_READ_ROLES,
)
def list_counters(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Counter]:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return list(
        db.scalars(
            select(Counter).where(Counter.agency_id == agency_id).order_by(Counter.number)
        ).all()
    )


@router.post(
    "/agencies/{agency_id}/counters",
    response_model=CounterResponse,
    status_code=201,
    dependencies=COUNTER_WRITE_ROLES,
)
def create_counter(
    agency_id: str,
    payload: CounterCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Counter:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)

    counter = Counter(agency_id=agency_id, **payload.model_dump())
    db.add(counter)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Ce numero de guichet est deja utilise dans cette agence"
        ) from exc
    db.refresh(counter)
    return counter


@router.put(
    "/counters/{counter_id}",
    response_model=CounterResponse,
    dependencies=COUNTER_WRITE_ROLES,
)
def update_counter(
    counter_id: str,
    payload: CounterUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Counter:
    counter = get_counter_or_404(counter_id, db)
    ensure_agency_scope(counter.agency_id, current_user)

    changes = payload.model_dump(exclude_unset=True)
    for required in ("number", "is_open"):
        if required in changes and changes[required] is None:
            raise HTTPException(status_code=422, detail=f"{required} ne peut pas etre vide")
    if changes.get("emotion_camera_id") is not None:
        camera = db.get(Camera, changes["emotion_camera_id"])
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera introuvable")
        if camera.agency_id != counter.agency_id:
            raise HTTPException(status_code=422, detail="Cette camera appartient a une autre agence")
    for field, value in changes.items():
        setattr(counter, field, value)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Ce numero de guichet est deja utilise dans cette agence"
        ) from exc
    db.refresh(counter)
    return counter


@router.delete("/counters/{counter_id}", status_code=204, dependencies=COUNTER_WRITE_ROLES)
def delete_counter(
    counter_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    counter = get_counter_or_404(counter_id, db)
    ensure_agency_scope(counter.agency_id, current_user)

    assigned_agent = db.scalar(select(User).where(User.counter_id == counter.id))
    if assigned_agent is not None:
        raise HTTPException(
            status_code=409,
            detail="Ce guichet est affecte a un agent. Desaffectez l agent avant de le supprimer",
        )

    serving = db.scalar(
        select(Ticket.id).where(
            Ticket.counter_id == counter.id,
            Ticket.status.in_((TicketStatus.CALLED, TicketStatus.IN_SERVICE)),
        )
    )
    if serving is not None:
        raise HTTPException(
            status_code=409,
            detail="Ce guichet a un ticket en cours. Terminez ou annulez-le avant de le supprimer",
        )

    # A deleted counter is not a deleted ticket - the visit still happened.
    # Same choice cameras.py already makes for Alert.camera_id on a camera
    # delete: null the reference, keep the record.
    for ticket in db.scalars(select(Ticket).where(Ticket.counter_id == counter.id)):
        ticket.counter_id = None

    db.delete(counter)
    db.commit()
