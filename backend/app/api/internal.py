from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.device_security import authenticate_ingestion_device
from app.database.connection import get_db
from app.models.entities import Agency, Employee, Service, Ticket, TicketStatus, Visitor, Zone
from app.schemas.ingestion import (
    CallNextRequest,
    CallNextResponse,
    DoorAccessRequest,
    DoorAccessResponse,
    KioskConfigResponse,
    KioskMessages,
    KioskServiceResponse,
    RFIDCheckRequest,
    RFIDCheckResponse,
    WalkInTicketRequest,
    WalkInTicketResponse,
)
from app.schemas.ticket_template import TicketTemplateResponse
from app.services.access_log import log_access_failure
from app.services.attendance_service import attendance_to_dict, record_rfid_event
from app.services.door_face import verify_face
from app.services.people_tracking import link_employee_tracking, link_ticket_tracking
from app.services.ticket_service import call_next_waiting_ticket, next_ticket_number
from app.services.ticket_template_service import stored_or_default_ticket_template
from app.services.visitor_recognition import link_visitor_face
from app.websocket.manager import attendance_manager


router = APIRouter(prefix="/internal", tags=["Internal ingestion"])


def event_time(value: datetime | None) -> datetime:
    return value or datetime.now(timezone.utc)


def resolve_service(payload: WalkInTicketRequest, db: Session) -> Service:
    if payload.service_id:
        service = db.get(Service, payload.service_id)
    elif payload.service_type:
        lookup = payload.service_type.strip().lower()
        service = db.scalar(
            select(Service).where(
                func.lower(Service.code) == lookup,
                Service.agency_id == payload.agency_id,
            )
        )
        if service is None:
            service = db.scalar(
                select(Service).where(
                    func.lower(Service.name) == lookup,
                    Service.agency_id == payload.agency_id,
                )
            )
    else:
        service = None

    if service is None:
        raise HTTPException(status_code=404, detail="Service introuvable")
    if service.agency_id != payload.agency_id:
        raise HTTPException(status_code=422, detail="Le service appartient a une autre agence")
    if not service.is_active:
        raise HTTPException(status_code=409, detail="Le service est inactif")
    return service


@router.post("/tickets/walk-in", response_model=WalkInTicketResponse, status_code=201)
def walk_in_ticket(
    payload: WalkInTicketRequest,
    background_tasks: BackgroundTasks,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> WalkInTicketResponse:
    authenticate_ingestion_device(payload.agency_id, payload.device_id, x_device_key, db)
    service = resolve_service(payload, db)
    occurred_at = event_time(payload.timestamp)
    visitor_data = payload.visitor.model_dump() if payload.visitor else {}
    visitor = Visitor(
        agency_id=payload.agency_id,
        full_name=visitor_data.get("full_name", "Visiteur borne"),
        phone=visitor_data.get("phone"),
        identity_reference=visitor_data.get("identity_reference"),
        created_at=occurred_at,
    )
    db.add(visitor)
    db.flush()

    ticket = Ticket(
        visitor_id=visitor.id,
        service_id=service.id,
        ticket_number=next_ticket_number(db, payload.agency_id, service.id, service.code),
        service_type=service.name,
        status=TicketStatus.WAITING,
        created_at=occurred_at,
    )
    db.add(ticket)
    db.commit()
    # Kiosk-zone tracking link - runs
    # after this response is already on its way back to the kiosk hardware,
    # so an AI-service round trip never delays printing the ticket.
    background_tasks.add_task(link_ticket_tracking, ticket.id, payload.agency_id)
    # Returning-visitor face capture (Phase D) - independent of the tracking
    # link above (one needs the zone's polygon, this needs its camera's
    # stream URL), they just happen to share the same zone fetch internally.
    background_tasks.add_task(link_visitor_face, ticket.id, payload.agency_id)
    return WalkInTicketResponse(
        ticket_id=ticket.id,
        ticket_number=ticket.ticket_number,
        service_id=service.id,
        service_type=service.name,
    )


@router.get("/tickets/kiosk-config", response_model=KioskConfigResponse)
def kiosk_config(
    agency_id: str,
    device_id: str,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> KioskConfigResponse:
    authenticate_ingestion_device(agency_id, device_id, x_device_key, db)
    services = db.scalars(
        select(Service)
        .options(selectinload(Service.counters))
        .where(Service.agency_id == agency_id, Service.is_active.is_(True))
        .order_by(Service.code)
    ).all()
    return KioskConfigResponse(
        services=[
            KioskServiceResponse(
                service_id=service.id,
                code=service.code,
                name=service.name,
                counter_id=next(
                    (
                        counter.id
                        for counter in sorted(service.counters, key=lambda item: item.number)
                        if counter.is_open
                    ),
                    None,
                ),
            )
            for service in services
        ],
        messages=KioskMessages(),
    )


@router.post("/tickets/call-next", response_model=CallNextResponse)
def call_next_from_device(
    payload: CallNextRequest,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> CallNextResponse:
    authenticate_ingestion_device(payload.agency_id, payload.device_id, x_device_key, db)
    ticket = call_next_waiting_ticket(
        db,
        agency_id=payload.agency_id,
        service_id=payload.service_id,
        counter_id=payload.counter_id,
    )
    if ticket is None:
        service = db.get(Service, payload.service_id)
        return CallNextResponse(called=False, service_code=service.code)
    return CallNextResponse(
        called=True,
        ticket_id=ticket.id,
        ticket_number=ticket.ticket_number,
        service_code=ticket.service.code,
    )


@router.get("/tickets/ticket-template", response_model=TicketTemplateResponse)
def ticket_template_from_device(
    agency_id: str,
    device_id: str,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> TicketTemplateResponse:
    authenticate_ingestion_device(agency_id, device_id, x_device_key, db)
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    return TicketTemplateResponse(template=stored_or_default_ticket_template(agency.ticket_template))


@router.post("/attendance/check-rfid", response_model=RFIDCheckResponse)
def check_rfid(
    payload: RFIDCheckRequest,
    background_tasks: BackgroundTasks,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> RFIDCheckResponse:
    device = authenticate_ingestion_device(payload.agency_id, payload.device_id, x_device_key, db)
    employee = db.scalar(
        select(Employee).where(
            Employee.rfid_uid == payload.employee_rfid,
            Employee.agency_id == payload.agency_id,
            Employee.is_active.is_(True),
        )
    )
    if employee is None:
        background_tasks.add_task(
            log_access_failure,
            payload.agency_id,
            device.id,
            payload.employee_rfid,
            "check_rfid",
            "unknown_card",
        )
        return RFIDCheckResponse(valid=False, message="Carte RFID ou employe introuvable")

    try:
        attendance, event = record_rfid_event(
            db,
            payload.employee_rfid,
            payload.timestamp,
            payload.agency_id,
        )
    except HTTPException as exc:
        background_tasks.add_task(
            log_access_failure,
            payload.agency_id,
            device.id,
            payload.employee_rfid,
            "check_rfid",
            "rejected",
            None,
            employee.id,
        )
        return RFIDCheckResponse(valid=False, message=str(exc.detail))

    # Employee badge-scan tracking link (Phase F) - runs after this response
    # is already on its way back to the device, same reasoning as every
    # other background task in this backlog. device.id is the real Device
    # primary key, not payload.device_id (which is the mqtt_client_id).
    background_tasks.add_task(link_employee_tracking, employee.id, device.id)

    # Same live update the MQTT attendance path sends. Without it a badge at
    # this REST reader (what the hardware contract uses) only reached the
    # Employee presence screen on its next reload.
    live = attendance_to_dict(attendance)
    live.update({"type": "attendance_updated", "device_id": payload.device_id, "event": event})
    attendance_manager.broadcast_from_thread(live)

    return RFIDCheckResponse(
        valid=True,
        employee_name=f"{employee.first_name} {employee.last_name}",
        event=event,
    )


@router.post("/access/door-access", response_model=DoorAccessResponse)
def door_access(
    payload: DoorAccessRequest,
    background_tasks: BackgroundTasks,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> DoorAccessResponse:
    """Authorize an RFID employee to enter an agency zone.

    Business denials intentionally return HTTP 200 with ``authorized: false`` so
    the ESP32 does not retry a valid but refused card indefinitely.
    """
    device = authenticate_ingestion_device(payload.agency_id, payload.device_id, x_device_key, db)

    zone = db.scalar(
        select(Zone).where(
            Zone.id == payload.zone_id,
            Zone.agency_id == payload.agency_id,
        )
    )
    if zone is None:
        zone_exists = db.get(Zone, payload.zone_id)
        if zone_exists is None:
            raise HTTPException(status_code=404, detail="Zone introuvable")
        raise HTTPException(status_code=422, detail="La zone appartient a une autre agence")

    employee = db.scalar(
        select(Employee)
        .options(selectinload(Employee.authorized_zones))
        .where(
            Employee.rfid_uid == payload.employee_rfid.strip(),
            Employee.agency_id == payload.agency_id,
        )
    )
    if employee is None:
        background_tasks.add_task(
            log_access_failure,
            payload.agency_id,
            device.id,
            payload.employee_rfid.strip(),
            "door_access",
            "unknown_card",
            zone.id,
        )
        return DoorAccessResponse(
            authorized=False,
            zone_id=zone.id,
            message="Carte RFID ou employe introuvable",
        )
    if not employee.is_active or employee.status.value != "ACTIVE":
        background_tasks.add_task(
            log_access_failure,
            payload.agency_id,
            device.id,
            payload.employee_rfid.strip(),
            "door_access",
            "employee_inactive",
            zone.id,
            employee.id,
        )
        return DoorAccessResponse(
            authorized=False,
            employee_name=f"{employee.first_name} {employee.last_name}",
            employee_role=employee.role.value,
            zone_id=zone.id,
            message="Employe inactif",
        )

    if zone.id not in employee.authorized_zone_ids:
        background_tasks.add_task(
            log_access_failure,
            payload.agency_id,
            device.id,
            payload.employee_rfid.strip(),
            "door_access",
            "zone_denied",
            zone.id,
            employee.id,
        )
        return DoorAccessResponse(
            authorized=False,
            employee_name=f"{employee.first_name} {employee.last_name}",
            employee_role=employee.role.value,
            zone_id=zone.id,
            message="Acces refuse pour cette zone",
        )

    # Badge + face rooms: the badge was right, now the face must be the badge
    # holder's (door_face.py). Fails closed, each refusal logged with why.
    if zone.access_mode == "rfid_face":
        face = verify_face(zone.door_camera, employee.id)
        if not face.ok:
            background_tasks.add_task(
                log_access_failure,
                payload.agency_id,
                device.id,
                payload.employee_rfid.strip(),
                "door_access",
                face.reason,
                zone.id,
                employee.id,
            )
            return DoorAccessResponse(
                authorized=False,
                employee_name=f"{employee.first_name} {employee.last_name}",
                employee_role=employee.role.value,
                zone_id=zone.id,
                message=face.message,
            )

    # Employee badge-scan tracking link (Phase F) - only on an actually
    # authorized scan, never on a refusal; same background-task reasoning
    # as check_rfid above.
    background_tasks.add_task(link_employee_tracking, employee.id, device.id)

    return DoorAccessResponse(
        authorized=True,
        employee_name=f"{employee.first_name} {employee.last_name}",
        employee_role=employee.role.value,
        zone_id=zone.id,
        message="Acces autorise",
    )
