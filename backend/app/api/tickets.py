from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, RoleName, Service, Ticket, TicketStatus, User, Visitor
from app.schemas.ticket import (
    PreviousVisit,
    VisitorHistoryResponse,
    TicketCallRequest,
    TicketCompleteRequest,
    TicketCreate,
    TicketResponse,
    TrackedTicketResponse,
)
from app.services.ticket_service import call_ticket_by_id, next_ticket_number
from app.services.visitor_recognition import FACE_MATCH_THRESHOLD, cosine_similarity


router = APIRouter(prefix="/tickets", tags=["Tickets"])
TICKET_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.AGENT))
]


def ticket_query():
    return select(Ticket).options(
        selectinload(Ticket.visitor),
        selectinload(Ticket.service),
        selectinload(Ticket.counter),
    )


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def ticket_to_response(ticket: Ticket) -> TicketResponse:
    return TicketResponse(
        id=ticket.id,
        visitor_id=ticket.visitor_id,
        visitor_name=ticket.visitor.full_name,
        agency_id=ticket.visitor.agency_id,
        service_id=ticket.service_id,
        service_code=ticket.service.code if ticket.service else None,
        service_name=ticket.service.name if ticket.service else None,
        counter_id=ticket.counter_id,
        ticket_number=ticket.ticket_number,
        service_type=ticket.service_type,
        status=ticket.status.value,
        created_at=ticket.created_at,
        called_at=ticket.called_at,
        in_service_at=ticket.in_service_at,
        completed_at=ticket.completed_at,
        notes=ticket.notes,
        tracking_id=ticket.tracking_id,
    )


@router.post("", response_model=TicketResponse, status_code=status.HTTP_201_CREATED, dependencies=TICKET_ROLES)
def create_ticket(
    payload: TicketCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    visitor = db.get(Visitor, payload.visitor_id)
    if visitor is None:
        raise HTTPException(status_code=404, detail="Visiteur introuvable")
    ensure_agency_scope(visitor.agency_id, current_user)

    service = db.get(Service, payload.service_id)
    if service is None:
        raise HTTPException(status_code=404, detail="Service introuvable")
    if service.agency_id != visitor.agency_id:
        raise HTTPException(status_code=422, detail="Le service appartient a une autre agence")
    if not service.is_active:
        raise HTTPException(status_code=409, detail="Le service est inactif")

    ticket = Ticket(
        visitor_id=visitor.id,
        service_id=service.id,
        ticket_number=next_ticket_number(db, visitor.agency_id, service.id, service.code),
        service_type=payload.service_type or service.name,
        status=TicketStatus.WAITING,
    )
    db.add(ticket)
    db.commit()
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket.id))
    return ticket_to_response(ticket)


@router.get("/queue", response_model=list[TicketResponse], dependencies=TICKET_ROLES)
def get_queue(
    service_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TicketResponse]:
    query = (
        ticket_query()
        .join(Ticket.visitor)
        .where(Ticket.status == TicketStatus.WAITING)
        .order_by(Ticket.created_at)
    )
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Visitor.agency_id == current_user.agency_id)
    if service_id is not None:
        service = db.get(Service, service_id)
        if service is None:
            raise HTTPException(status_code=404, detail="Service introuvable")
        ensure_agency_scope(service.agency_id, current_user)
        query = query.where(Ticket.service_id == service.id)
    return [ticket_to_response(ticket) for ticket in db.scalars(query).unique().all()]


@router.get(
    "/tracked",
    response_model=list[TrackedTicketResponse],
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))],
)
def list_tracked_tickets(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TrackedTicketResponse]:
    """For the live map (Tracking.tsx) to relabel a tracked person by ticket
    number - same roles as /tracking itself, not TICKET_ROLES, since this is
    a monitoring read, not a ticket-handling action."""
    query = (
        select(Ticket)
        .join(Ticket.visitor)
        .where(
            Ticket.tracking_id.is_not(None),
            Ticket.status.not_in(
                (TicketStatus.COMPLETED, TicketStatus.CANCELLED, TicketStatus.NO_SHOW)
            ),
        )
    )
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Visitor.agency_id == current_user.agency_id)
    return [
        TrackedTicketResponse(
            ticket_id=ticket.id, ticket_number=ticket.ticket_number, tracking_id=ticket.tracking_id
        )
        for ticket in db.scalars(query).unique().all()
    ]


@router.post("/{ticket_id}/call", response_model=TicketResponse, dependencies=TICKET_ROLES)
def call_ticket(
    ticket_id: str,
    payload: TicketCallRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    ensure_agency_scope(ticket.visitor.agency_id, current_user)
    ticket = call_ticket_by_id(db, ticket_id, payload.counter_id)
    return ticket_to_response(ticket)


@router.post("/{ticket_id}/complete", response_model=TicketResponse, dependencies=TICKET_ROLES)
def complete_ticket(
    ticket_id: str,
    payload: TicketCompleteRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    ensure_agency_scope(ticket.visitor.agency_id, current_user)
    if ticket.status not in (TicketStatus.CALLED, TicketStatus.IN_SERVICE):
        raise HTTPException(status_code=409, detail="Ce ticket ne peut pas etre termine")
    ticket.status = TicketStatus.COMPLETED
    ticket.completed_at = datetime.now(timezone.utc)
    # Completed straight from CALLED (no "start service"): the visit still
    # happened, from the moment the visitor was called. Without a start the
    # visit had no service time and no satisfaction window at all.
    if ticket.in_service_at is None:
        ticket.in_service_at = ticket.called_at or ticket.completed_at
    ticket.notes = (
        payload.notes.strip()
        if payload is not None and payload.notes is not None and payload.notes.strip()
        else None
    )
    db.commit()
    return ticket_to_response(ticket)


@router.post("/{ticket_id}/cancel", response_model=TicketResponse, dependencies=TICKET_ROLES)
def cancel_ticket(
    ticket_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    ensure_agency_scope(ticket.visitor.agency_id, current_user)
    if ticket.status in (TicketStatus.COMPLETED, TicketStatus.CANCELLED):
        raise HTTPException(status_code=409, detail="Ce ticket est deja termine ou annule")
    ticket.status = TicketStatus.CANCELLED
    db.commit()
    return ticket_to_response(ticket)


@router.post("/{ticket_id}/start-service", response_model=TicketResponse, dependencies=TICKET_ROLES)
def start_service(
    ticket_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    """Manual, agent-pressed - marks the moment the visitor actually arrived
    at the counter. Deliberately not auto-detected via tracking (scenario
    planning session, 2026-09-30/10-01); this is what lets "walk-over time"
    (called -> here) and "service duration" (here -> completed) be told
    apart instead of blended into one number."""
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    ensure_agency_scope(ticket.visitor.agency_id, current_user)
    if ticket.status != TicketStatus.CALLED:
        raise HTTPException(status_code=409, detail="Ce ticket n est pas en cours d appel")
    ticket.status = TicketStatus.IN_SERVICE
    ticket.in_service_at = datetime.now(timezone.utc)
    db.commit()
    return ticket_to_response(ticket)


@router.post("/{ticket_id}/skip", response_model=TicketResponse, dependencies=TICKET_ROLES)
def skip_ticket(
    ticket_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    """The no-show button - always a human decision, never automatic. The
    wait enforced below is a server-side backstop (the real gate is the
    disabled button on the agent's screen); it stops a direct API call or a
    second client from skipping someone the instant they're called."""
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    ensure_agency_scope(ticket.visitor.agency_id, current_user)
    if ticket.status != TicketStatus.CALLED:
        raise HTTPException(status_code=409, detail="Ce ticket n est pas en cours d appel")
    agency = db.get(Agency, ticket.visitor.agency_id)
    min_wait = agency.no_show_min_wait_seconds if agency else 60
    elapsed = (datetime.now(timezone.utc) - ticket.called_at).total_seconds()
    if elapsed < min_wait:
        raise HTTPException(
            status_code=409,
            detail=f"Attendre encore {int(min_wait - elapsed)}s avant de marquer ce ticket absent",
        )
    ticket.status = TicketStatus.NO_SHOW
    db.commit()
    return ticket_to_response(ticket)


@router.get("/{ticket_id}/history", response_model=VisitorHistoryResponse, dependencies=TICKET_ROLES)
def visitor_history(
    ticket_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VisitorHistoryResponse:
    """Has this visitor been here before? Every kiosk visit is a new anonymous
    Visitor; the only thing tying visits together is the face captured at the
    kiosk (visitor_recognition.py). Same matching and threshold as the
    returning-visitor count in Insights, done for one ticket so the agent at
    the counter sees it (2026-10-18 day test). Up to 5 earlier visits, newest
    first. `recognised` is false when no face was captured for this visit,
    which is not the same as "first visit"."""
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    agency_id = ticket.visitor.agency_id
    ensure_agency_scope(agency_id, current_user)

    embedding = ticket.visitor.face_embedding
    if not embedding:
        return VisitorHistoryResponse(recognised=False, previous_visits=[])

    earlier = db.scalars(
        select(Visitor).where(
            Visitor.agency_id == agency_id,
            Visitor.id != ticket.visitor_id,
            Visitor.face_embedding.is_not(None),
            Visitor.created_at < ticket.visitor.created_at,
        )
    ).all()
    same_person = [
        v.id for v in earlier if cosine_similarity(embedding, v.face_embedding) >= FACE_MATCH_THRESHOLD
    ]
    if not same_person:
        return VisitorHistoryResponse(recognised=True, previous_visits=[])

    visits = db.scalars(
        ticket_query()
        .where(Ticket.visitor_id.in_(same_person))
        .order_by(Ticket.created_at.desc())
        .limit(5)
    ).all()
    return VisitorHistoryResponse(
        recognised=True,
        previous_visits=[
            PreviousVisit(
                ticket_number=v.ticket_number,
                service_name=v.service.name if v.service else None,
                status=v.status.value,
                created_at=v.created_at,
                notes=v.notes,
            )
            for v in visits
        ],
    )
