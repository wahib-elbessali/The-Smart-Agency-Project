from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.agencies import get_accessible_agency
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import RoleName, User
from app.schemas.ticket_template import TicketTemplateResponse, TicketTemplateUpdate
from app.services.ticket_template_service import (
    process_ticket_template,
    stored_or_default_ticket_template,
)


router = APIRouter(prefix="/agencies", tags=["Ticket templates"])
TEMPLATE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


@router.get(
    "/{agency_id}/ticket-template",
    response_model=TicketTemplateResponse,
    dependencies=TEMPLATE_ROLES,
)
def get_ticket_template(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketTemplateResponse:
    agency = get_accessible_agency(agency_id, current_user, db)
    return TicketTemplateResponse(template=stored_or_default_ticket_template(agency.ticket_template))


@router.put(
    "/{agency_id}/ticket-template",
    response_model=TicketTemplateResponse,
    dependencies=TEMPLATE_ROLES,
)
def update_ticket_template(
    agency_id: str,
    payload: TicketTemplateUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketTemplateResponse:
    agency = get_accessible_agency(agency_id, current_user, db)
    agency.ticket_template = process_ticket_template(payload.template)
    db.commit()
    db.refresh(agency)
    return TicketTemplateResponse(template=stored_or_default_ticket_template(agency.ticket_template))
