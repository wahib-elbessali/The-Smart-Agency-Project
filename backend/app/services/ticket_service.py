import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.entities import Counter, Device, Service, Ticket, TicketStatus, Visitor
from app.mqtt.sensor_consumer import sensor_consumer
from app.mqtt.topics import TICKET_CALLED_TOPIC


logger = logging.getLogger(__name__)


def ticket_query():
    return select(Ticket).options(
        selectinload(Ticket.visitor),
        selectinload(Ticket.service),
        selectinload(Ticket.counter),
    )


def next_ticket_number(db: Session, agency_id: str, service_id: str, service_code: str) -> str:
    today = datetime.now(timezone.utc).date()
    prefix = f"{today.strftime('%Y%m%d')}%"
    count = db.scalar(
        select(func.count(Ticket.id))
        .join(Ticket.visitor)
        .where(
            Visitor.agency_id == agency_id,
            Ticket.service_id == service_id,
            Ticket.ticket_number.like(prefix),
        )
    ) or 0
    return f"{today.strftime('%Y%m%d')}-{service_code[:10]}-{count + 1:03d}"


def validate_counter_for_service(
    db: Session,
    agency_id: str,
    service_id: str,
    counter_id: str,
) -> tuple[Service, Counter]:
    service = db.get(Service, service_id)
    if service is None:
        raise HTTPException(status_code=404, detail="Service introuvable")
    if service.agency_id != agency_id:
        raise HTTPException(status_code=422, detail="Le service appartient a une autre agence")
    if not service.is_active:
        raise HTTPException(status_code=409, detail="Le service est inactif")

    counter = db.get(Counter, counter_id)
    if counter is None:
        raise HTTPException(status_code=404, detail="Guichet introuvable")
    if counter.agency_id != agency_id:
        raise HTTPException(status_code=422, detail="Le guichet appartient a une autre agence")
    if not counter.is_open:
        raise HTTPException(status_code=409, detail="Le guichet est ferme")
    if counter.service_id != service.id:
        raise HTTPException(status_code=422, detail="Le guichet n est pas affecte au service")
    if counter.point_type != service.point_type:
        raise HTTPException(status_code=422, detail="Le type de point ne correspond pas au service")
    return service, counter


def _validate_counter_for_ticket(db: Session, ticket: Ticket, counter_id: str) -> Counter:
    counter = db.get(Counter, counter_id)
    if counter is None:
        raise HTTPException(status_code=404, detail="Guichet introuvable")
    if counter.agency_id != ticket.visitor.agency_id:
        raise HTTPException(status_code=422, detail="Le guichet appartient a une autre agence")
    if not counter.is_open:
        raise HTTPException(status_code=409, detail="Le guichet est ferme")
    if ticket.service_id is not None and counter.service_id != ticket.service_id:
        raise HTTPException(status_code=422, detail="Le guichet n est pas affecte au service du ticket")
    if ticket.service is not None and counter.point_type != ticket.service.point_type:
        raise HTTPException(status_code=422, detail="Le type de point ne correspond pas au service du ticket")
    return counter


def _commit_called_ticket(db: Session, ticket: Ticket, counter: Counter) -> Ticket:
    ticket.counter_id = counter.id
    ticket.status = TicketStatus.CALLED
    ticket.called_at = datetime.now(timezone.utc)
    db.commit()
    called_ticket = db.scalar(ticket_query().where(Ticket.id == ticket.id))
    if called_ticket is None:
        raise RuntimeError("Le ticket appele est introuvable apres validation")
    publish_ticket_called(db, called_ticket)
    return called_ticket


def call_ticket_by_id(db: Session, ticket_id: str, counter_id: str) -> Ticket:
    ticket = db.scalar(ticket_query().where(Ticket.id == ticket_id))
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket introuvable")
    if ticket.status != TicketStatus.WAITING:
        raise HTTPException(status_code=409, detail="Ce ticket n est plus en attente")
    counter = _validate_counter_for_ticket(db, ticket, counter_id)
    return _commit_called_ticket(db, ticket, counter)


def call_next_waiting_ticket(
    db: Session,
    agency_id: str,
    service_id: str,
    counter_id: str,
) -> Ticket | None:
    service, counter = validate_counter_for_service(db, agency_id, service_id, counter_id)
    waiting_ticket = db.scalar(
        ticket_query()
        .join(Ticket.visitor)
        .where(
            Visitor.agency_id == agency_id,
            Ticket.service_id == service.id,
            Ticket.status == TicketStatus.WAITING,
        )
        .order_by(Ticket.created_at, Ticket.id)
        .with_for_update(skip_locked=True)
    )
    if waiting_ticket is None:
        return None
    return _commit_called_ticket(db, waiting_ticket, counter)


def publish_ticket_called(db: Session, ticket: Ticket) -> None:
    """Notify every queue display configured in the ticket's agency.

    This function is called only after the ticket state has been committed.
    MQTT is best-effort: a broker/device outage is logged, while the already
    successful ticket call remains successful for the HTTP client.
    """
    if ticket.service is None:
        logger.warning("Ticket %s has no service; ticket-called was not published", ticket.id)
        return

    displays = db.scalars(
        select(Device).where(
            Device.agency_id == ticket.visitor.agency_id,
            func.upper(Device.device_type) == "QUEUE_DISPLAY",
        )
    ).all()

    payload = {
        "service_code": ticket.service.code,
        "ticket_number": ticket.ticket_number,
    }

    if not displays:
        logger.warning(
            "No QUEUE_DISPLAY device configured for agency %s; ticket-called was not published",
            ticket.visitor.agency_id,
        )
        return

    for display in displays:
        topic = TICKET_CALLED_TOPIC.format(
            agency_id=ticket.visitor.agency_id,
            device_id=display.mqtt_client_id,
        )
        if not sensor_consumer.publish_command(topic, payload):
            logger.warning("Unable to publish ticket-called notification to %s", topic)
