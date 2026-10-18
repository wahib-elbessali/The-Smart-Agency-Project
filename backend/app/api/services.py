from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Counter, RoleName, Service, Ticket, User
from app.schemas.service import (
    CounterServiceAssignment,
    ServiceCreate,
    ServicePointResponse,
    ServiceResponse,
    ServiceUpdate,
)


router = APIRouter(tags=["Services"])
SERVICE_READ_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.AGENT))]
SERVICE_WRITE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def get_agency_or_404(agency_id: str, db: Session) -> Agency:
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    return agency


def get_service_or_404(service_id: str, db: Session) -> Service:
    service = db.get(Service, service_id)
    if service is None:
        raise HTTPException(status_code=404, detail="Service introuvable")
    return service


def normalize_code(code: str) -> str:
    return code.strip().upper()


def service_integrity_error_response(exc: IntegrityError) -> HTTPException | None:
    """Translate known PostgreSQL constraint errors without masking them.

    Only the service-code uniqueness constraint is a conflict (409). A
    NOT-NULL or CHECK violation is invalid input (422), not a duplicate code.
    Unknown database errors are re-raised so they remain visible in logs.
    """
    original = exc.orig
    pgcode = getattr(original, "pgcode", None)
    diagnostic = getattr(original, "diag", None)
    constraint_name = getattr(diagnostic, "constraint_name", None)
    error_text = str(original).lower()

    duplicate_code = (
        pgcode == "23505"
        and constraint_name in {"uq_service_agency_code", "services_agency_id_code_key"}
    ) or "uq_service_agency_code" in error_text or (
        "unique constraint" in error_text and "code" in error_text
    )
    if duplicate_code:
        return HTTPException(
            status_code=409,
            detail="Ce code de service existe deja dans cette agence",
        )
    if pgcode in {"23502", "23514"} or "not-null constraint" in error_text or "not null constraint" in error_text:
        return HTTPException(
            status_code=422,
            detail="Les donnees du service sont invalides",
        )
    return None


@router.get(
    "/services/{service_id}/points",
    response_model=list[ServicePointResponse],
    dependencies=SERVICE_READ_ROLES,
)
def list_service_points(
    service_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ServicePointResponse]:
    service = get_service_or_404(service_id, db)
    ensure_agency_scope(service.agency_id, current_user)
    query = select(Counter).where(Counter.service_id == service.id).order_by(Counter.number)
    return list(db.scalars(query).all())


@router.patch(
    "/counters/{counter_id}/service",
    response_model=ServicePointResponse,
    dependencies=SERVICE_WRITE_ROLES,
)
def assign_counter_to_service(
    counter_id: str,
    payload: CounterServiceAssignment,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ServicePointResponse:
    counter = db.get(Counter, counter_id)
    if counter is None:
        raise HTTPException(status_code=404, detail="Guichet ou bureau introuvable")
    ensure_agency_scope(counter.agency_id, current_user)

    if payload.service_id is None:
        assigned_agent_id = db.scalar(select(User.id).where(User.counter_id == counter.id))
        if assigned_agent_id is not None:
            raise HTTPException(
                status_code=409,
                detail="Ce guichet est affecte a un agent. Desaffectez l agent avant de retirer le service",
            )
        counter.service_id = None
        counter.point_type = "COUNTER"
    else:
        service = get_service_or_404(payload.service_id, db)
        if service.agency_id != counter.agency_id:
            raise HTTPException(status_code=422, detail="Le service et le point doivent appartenir a la meme agence")
        if not service.is_active:
            raise HTTPException(status_code=409, detail="Impossible d affecter un point a un service inactif")
        counter.service_id = service.id
        counter.point_type = service.point_type

    db.commit()
    db.refresh(counter)
    return counter


@router.get(
    "/agencies/{agency_id}/services",
    response_model=list[ServiceResponse],
    dependencies=SERVICE_READ_ROLES,
)
def list_services(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ServiceResponse]:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    query = select(Service).where(Service.agency_id == agency_id).order_by(Service.name)
    return list(db.scalars(query).all())


@router.post(
    "/agencies/{agency_id}/services",
    response_model=ServiceResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=SERVICE_WRITE_ROLES,
)
def create_service(
    agency_id: str,
    payload: ServiceCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ServiceResponse:
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency.id, current_user)
    if not agency.is_active:
        raise HTTPException(status_code=409, detail="Impossible d ajouter un service a une agence inactive")

    service = Service(
        agency_id=agency_id,
        code=normalize_code(payload.code),
        name=payload.name.strip(),
        description=payload.description.strip() if payload.description else None,
        point_type=payload.point_type,
        min_points=payload.min_points,
        is_active=payload.is_active,
    )
    db.add(service)
    try:
        db.commit()
        db.refresh(service)
    except IntegrityError as exc:
        db.rollback()
        response = service_integrity_error_response(exc)
        if response is not None:
            raise response from exc
        raise
    return service


@router.get(
    "/services/{service_id}",
    response_model=ServiceResponse,
    dependencies=SERVICE_READ_ROLES,
)
def get_service(
    service_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ServiceResponse:
    service = get_service_or_404(service_id, db)
    ensure_agency_scope(service.agency_id, current_user)
    return service


@router.put(
    "/services/{service_id}",
    response_model=ServiceResponse,
    dependencies=SERVICE_WRITE_ROLES,
)
def update_service(
    service_id: str,
    payload: ServiceUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ServiceResponse:
    service = get_service_or_404(service_id, db)
    ensure_agency_scope(service.agency_id, current_user)
    changes = payload.model_dump(exclude_unset=True)
    if "point_type" in changes and changes["point_type"] != service.point_type:
        assigned_point_id = db.scalar(select(Counter.id).where(Counter.service_id == service.id))
        if assigned_point_id is not None:
            raise HTTPException(
                status_code=409,
                detail="Des guichets ou bureaux sont deja affectes a ce service",
            )
    if "code" in changes:
        changes["code"] = normalize_code(changes["code"])
    if "name" in changes:
        changes["name"] = changes["name"].strip()
    if "description" in changes and changes["description"] is not None:
        changes["description"] = changes["description"].strip()
    for field, value in changes.items():
        setattr(service, field, value)

    try:
        db.commit()
        db.refresh(service)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Ce code de service existe deja dans cette agence") from exc
    return service


@router.delete(
    "/services/{service_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=SERVICE_WRITE_ROLES,
)
def delete_service(
    service_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    service = get_service_or_404(service_id, db)
    ensure_agency_scope(service.agency_id, current_user)
    if db.scalar(select(Counter.id).where(Counter.service_id == service.id)) is not None:
        raise HTTPException(status_code=409, detail="Des guichets ou bureaux sont encore affectes a ce service")
    if db.scalar(select(Ticket.id).where(Ticket.service_id == service.id)) is not None:
        raise HTTPException(status_code=409, detail="Des tickets utilisent encore ce service")
    db.delete(service)
    db.commit()
