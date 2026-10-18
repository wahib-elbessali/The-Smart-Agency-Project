from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.security import get_current_user, hash_password, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Employee, Role, RoleName, User
from app.schemas.user import (
    AccessUpdate,
    AgencyAssignment,
    RoleUpdate,
    UserCreate,
    UserResponse,
    UserUpdate,
)


router = APIRouter(prefix="/users", tags=["Users"])
ADMIN_ONLY = [Depends(require_roles(RoleName.ADMIN))]


def normalize_role(value: str) -> RoleName:
    try:
        return RoleName(value.upper())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="Role invalide. Valeurs: ADMIN, MANAGER, AGENT, SECURITY, TECHNICIAN",
        ) from exc


def user_query():
    return select(User).options(
        selectinload(User.role),
        selectinload(User.employee),
    )


def get_user_or_404(user_id: str, db: Session) -> User:
    user = db.scalar(user_query().where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return user


def validate_agency_for_role(role: RoleName, agency_id: str | None, db: Session) -> None:
    if role == RoleName.ADMIN:
        if agency_id is not None:
            raise HTTPException(status_code=422, detail="Un ADMIN est global et ne doit pas avoir d agence")
        return
    if agency_id is None:
        raise HTTPException(status_code=422, detail="Une agence est obligatoire pour ce role")
    if db.get(Agency, agency_id) is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")


def link_employee(user: User, employee_id: str | None, agency_id: str | None, db: Session) -> None:
    if employee_id is None:
        user.employee = None
        return

    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    if employee.user_id is not None and employee.user_id != user.id:
        raise HTTPException(status_code=409, detail="Cet employe est deja lie a un compte")
    if agency_id is not None and employee.agency_id != agency_id:
        raise HTTPException(status_code=422, detail="L employe et l utilisateur doivent appartenir a la meme agence")
    user.employee = employee


def to_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        role=user.role.name.value,
        agency_id=user.agency_id,
        employee_id=user.employee.id if user.employee else None,
        is_active=user.is_active,
        employee=user.employee,
    )


@router.get("", response_model=list[UserResponse], dependencies=ADMIN_ONLY)
def list_users(db: Session = Depends(get_db)) -> list[UserResponse]:
    return [to_response(user) for user in db.scalars(user_query().order_by(User.full_name)).unique().all()]


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED, dependencies=ADMIN_ONLY)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> UserResponse:
    role_name = normalize_role(payload.role)
    validate_agency_for_role(role_name, payload.agency_id, db)

    if db.scalar(select(User).where(User.email == payload.email.strip().lower())) is not None:
        raise HTTPException(status_code=409, detail="Cette adresse email existe deja")

    role = db.scalar(select(Role).where(Role.name == role_name))
    if role is None:
        role = Role(name=role_name, description=f"Role {role_name.value}")
        db.add(role)
        db.flush()

    user = User(
        full_name=payload.full_name.strip(),
        email=payload.email.strip().lower(),
        password_hash=hash_password(payload.password),
        role_id=role.id,
        agency_id=payload.agency_id,
    )
    db.add(user)
    db.flush()
    link_employee(user, payload.employee_id, payload.agency_id, db)
    if user.employee is not None:
        user.employee.role = role_name
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email ou liaison employe deja utilise") from exc
    return to_response(get_user_or_404(user.id, db))


@router.get("/{user_id}", response_model=UserResponse, dependencies=ADMIN_ONLY)
def get_user(user_id: str, db: Session = Depends(get_db)) -> UserResponse:
    return to_response(get_user_or_404(user_id, db))


@router.put("/{user_id}", response_model=UserResponse, dependencies=ADMIN_ONLY)
def update_user(user_id: str, payload: UserUpdate, db: Session = Depends(get_db)) -> UserResponse:
    user = get_user_or_404(user_id, db)
    changes = payload.model_dump(exclude_unset=True)

    if "email" in changes and changes["email"]:
        changes["email"] = changes["email"].strip().lower()
    if "password" in changes and changes["password"]:
        changes["password_hash"] = hash_password(changes.pop("password"))
    employee_id = changes.pop("employee_id", None) if "employee_id" in changes else user.employee.id if user.employee else None

    for field, value in changes.items():
        setattr(user, field, value.strip() if isinstance(value, str) else value)
    link_employee(user, employee_id, user.agency_id, db)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email ou liaison employe deja utilise") from exc
    return to_response(get_user_or_404(user.id, db))


@router.patch("/{user_id}/role", response_model=UserResponse, dependencies=ADMIN_ONLY)
def update_user_role(user_id: str, payload: RoleUpdate, db: Session = Depends(get_db)) -> UserResponse:
    user = get_user_or_404(user_id, db)
    new_role = normalize_role(payload.role)
    validate_agency_for_role(new_role, user.agency_id if new_role != RoleName.ADMIN else None, db)
    role = db.scalar(select(Role).where(Role.name == new_role))
    if role is None:
        role = Role(name=new_role, description=f"Role {new_role.value}")
        db.add(role)
        db.flush()
    user.role = role
    if user.employee is not None:
        user.employee.role = new_role
    if new_role != RoleName.AGENT:
        user.counter_id = None
    if new_role == RoleName.ADMIN:
        user.agency_id = None
    db.commit()
    return to_response(get_user_or_404(user.id, db))


@router.patch("/{user_id}/access", response_model=UserResponse, dependencies=ADMIN_ONLY)
def update_user_access(user_id: str, payload: AccessUpdate, db: Session = Depends(get_db)) -> UserResponse:
    """Update role and agency atomically using the resulting state."""
    user = get_user_or_404(user_id, db)
    target_role = normalize_role(payload.role)
    target_agency_id = payload.agency_id

    # Validate the final role/agency pair, not the user's current state.
    validate_agency_for_role(target_role, target_agency_id, db)

    role = db.scalar(select(Role).where(Role.name == target_role))
    if role is None:
        role = Role(name=target_role, description=f"Role {target_role.value}")
        db.add(role)
        db.flush()

    previous_agency_id = user.agency_id
    user.role = role
    user.agency_id = target_agency_id
    if target_role != RoleName.AGENT or target_agency_id != previous_agency_id:
        user.counter_id = None
    if user.employee is not None:
        user.employee.role = target_role

    # A linked employee follows the new agency. An ADMIN remains global,
    # but the linked employee keeps its professional agency assignment.
    if user.employee is not None and target_agency_id is not None:
        user.employee.agency_id = target_agency_id

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Impossible de modifier les acces de cet utilisateur") from exc
    return to_response(get_user_or_404(user.id, db))


@router.patch("/{user_id}/agency", response_model=UserResponse, dependencies=ADMIN_ONLY)
def update_user_agency(user_id: str, payload: AgencyAssignment, db: Session = Depends(get_db)) -> UserResponse:
    user = get_user_or_404(user_id, db)
    role_name = user.role.name
    validate_agency_for_role(role_name, payload.agency_id, db)
    if payload.agency_id != user.agency_id:
        user.counter_id = None
    user.agency_id = payload.agency_id
    if user.employee is not None:
        user.employee.agency_id = payload.agency_id
    db.commit()
    return to_response(get_user_or_404(user.id, db))


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=ADMIN_ONLY)
def delete_user(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Un ADMIN ne peut pas supprimer son propre compte")
    user = get_user_or_404(user_id, db)
    db.delete(user)
    db.commit()
