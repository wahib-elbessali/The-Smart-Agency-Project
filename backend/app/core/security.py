from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database.connection import get_db
from app.models.entities import RoleName, User


ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def _create_token(subject: str, role: str, token_type: str, expires_minutes: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "role": role,
        "type": token_type,
        "iat": now,
        "exp": now + timedelta(minutes=expires_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def create_access_token(user: User) -> str:
    return _create_token(
        subject=user.id,
        role=user.role.name.value,
        token_type="access",
        expires_minutes=settings.access_token_expire_minutes,
    )


def create_refresh_token(user: User) -> str:
    return _create_token(
        subject=user.id,
        role=user.role.name.value,
        token_type="refresh",
        expires_minutes=settings.access_token_expire_minutes * 24 * 7,
    )


def _unauthorized(detail: str = "Token invalide ou expire") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def decode_token(token: str, expected_type: str = "access") -> dict:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError as exc:
        raise _unauthorized() from exc

    if payload.get("type") != expected_type or not payload.get("sub"):
        raise _unauthorized()
    return payload


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise _unauthorized("Authentification requise")

    payload = decode_token(credentials.credentials)
    user = db.scalar(
        select(User).where(
            User.id == payload["sub"],
            User.is_active.is_(True),
        )
    )
    if user is None:
        raise _unauthorized("Utilisateur introuvable ou desactive")
    return user


def require_roles(*allowed_roles: RoleName) -> Callable:
    def role_dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role.name not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permissions insuffisantes",
            )
        return current_user

    return role_dependency
