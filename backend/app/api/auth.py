from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.core.login_throttle import login_throttle
from app.database.connection import get_db
from app.models.entities import Role, RoleName, User
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)


router = APIRouter(prefix="/auth", tags=["Authentication"])

# Checked against when the email is unknown, so a wrong email takes as long to
# refuse as a wrong password and response time does not reveal which accounts exist.
_DUMMY_HASH = hash_password("not-a-real-password")


def serialize_user(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        role=user.role.name.value,
        agency_id=user.agency_id,
        is_active=user.is_active,
    )


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> UserResponse:
    email = str(payload.email).strip().lower()
    existing_user = db.scalar(select(User).where(User.email == email))
    if existing_user is not None:
        raise HTTPException(status_code=409, detail="Cette adresse email existe deja")

    # Une inscription publique cree toujours un agent, sans agence: l'acces aux
    # donnees d'une agence (visiteurs, tickets) est donne par un administrateur,
    # sinon n'importe qui pourrait s'inscrire dans l'agence de son choix.
    if payload.agency_id is not None:
        raise HTTPException(
            status_code=403, detail="Seul un administrateur peut affecter un compte a une agence"
        )
    role = db.scalar(select(Role).where(Role.name == RoleName.AGENT))
    if role is None:
        role = Role(name=RoleName.AGENT, description="Gestion des visiteurs et des tickets")
        db.add(role)
        db.flush()

    user = User(
        full_name=payload.full_name.strip(),
        email=email,
        password_hash=hash_password(payload.password),
        role_id=role.id,
        agency_id=payload.agency_id,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Impossible de creer ce compte") from exc
    db.refresh(user)
    return serialize_user(user)


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest, request: Request, db: Session = Depends(get_db)
) -> TokenResponse:
    email = str(payload.email).strip().lower()
    client = request.client.host if request.client else "unknown"
    login_throttle.check(email, client)
    user = db.scalar(select(User).where(User.email == email))
    password_ok = verify_password(
        payload.password, user.password_hash if user is not None else _DUMMY_HASH
    )
    if user is None or not password_ok:
        login_throttle.failed(email, client)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email ou mot de passe incorrect",
            headers={"WWW-Authenticate": "Bearer"},
        )
    login_throttle.succeeded(email)
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Compte desactive")

    return TokenResponse(
        access_token=create_access_token(user),
        refresh_token=create_refresh_token(user),
        user=serialize_user(user),
    )


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return serialize_user(current_user)


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    token_data = decode_token(payload.refresh_token, expected_type="refresh")
    user = db.scalar(
        select(User).where(
            User.id == token_data["sub"],
            User.is_active.is_(True),
        )
    )
    if user is None:
        raise HTTPException(status_code=401, detail="Utilisateur introuvable ou desactive")

    return TokenResponse(
        access_token=create_access_token(user),
        refresh_token=create_refresh_token(user),
        user=serialize_user(user),
    )
