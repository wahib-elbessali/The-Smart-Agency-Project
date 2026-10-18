from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import PushSubscription, RoleName, User
from app.schemas.push import PushPublicKeyResponse, PushSubscriptionCreate


router = APIRouter(prefix="/push", tags=["Push notifications"])

NOTIFIED_ROLES = (RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY)


@router.get(
    "/public-key",
    response_model=PushPublicKeyResponse,
    dependencies=[Depends(require_roles(*NOTIFIED_ROLES))],
)
def get_public_key() -> PushPublicKeyResponse:
    configured = bool(settings.vapid_public_key and settings.vapid_private_key)
    return PushPublicKeyResponse(
        public_key=settings.vapid_public_key if configured else None,
        push_enabled=configured and settings.notifications_enabled,
    )


@router.post(
    "/subscriptions",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(*NOTIFIED_ROLES))],
)
def save_subscription(
    payload: PushSubscriptionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Idempotent by endpoint: re-subscribing the same browser (or a different
    user signing in on it) moves the subscription rather than duplicating it."""
    existing = db.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if existing is None:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=payload.endpoint,
                p256dh=payload.keys.p256dh,
                auth=payload.keys.auth,
            )
        )
    else:
        existing.user_id = current_user.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
    db.commit()


@router.delete(
    "/subscriptions",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(*NOTIFIED_ROLES))],
)
def delete_subscription(
    endpoint: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    subscription = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == current_user.id,
        )
    )
    if subscription is not None:
        db.delete(subscription)
        db.commit()
