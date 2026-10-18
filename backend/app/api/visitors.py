from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, RoleName, User, Visitor
from app.schemas.visitor import VisitorCreate, VisitorResponse


router = APIRouter(prefix="/visitors", tags=["Visitors"])
VISITOR_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.AGENT, RoleName.SECURITY))
]


def visitor_to_response(visitor: Visitor) -> VisitorResponse:
    return VisitorResponse(
        id=visitor.id,
        agency_id=visitor.agency_id,
        full_name=visitor.full_name,
        phone=visitor.phone,
        identity_reference=visitor.identity_reference,
        created_at=visitor.created_at,
    )


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


@router.post("", response_model=VisitorResponse, status_code=status.HTTP_201_CREATED, dependencies=VISITOR_ROLES)
def create_visitor(
    payload: VisitorCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VisitorResponse:
    agency_id = payload.agency_id
    if current_user.role.name != RoleName.ADMIN:
        agency_id = current_user.agency_id
    if agency_id is None:
        raise HTTPException(status_code=422, detail="agency_id est obligatoire")
    if db.get(Agency, agency_id) is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")

    visitor = Visitor(
        agency_id=agency_id,
        full_name=payload.full_name.strip(),
        phone=payload.phone,
        identity_reference=payload.identity_reference,
    )
    db.add(visitor)
    db.commit()
    db.refresh(visitor)
    return visitor_to_response(visitor)


@router.get("", response_model=list[VisitorResponse], dependencies=VISITOR_ROLES)
def list_visitors(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[VisitorResponse]:
    query = select(Visitor).order_by(Visitor.created_at.desc())
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Visitor.agency_id == current_user.agency_id)
    return [visitor_to_response(visitor) for visitor in db.scalars(query).all()]


@router.get("/{visitor_id}", response_model=VisitorResponse, dependencies=VISITOR_ROLES)
def get_visitor(
    visitor_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VisitorResponse:
    visitor = db.get(Visitor, visitor_id)
    if visitor is None:
        raise HTTPException(status_code=404, detail="Visiteur introuvable")
    ensure_agency_scope(visitor.agency_id, current_user)
    return visitor_to_response(visitor)
