from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.ai_alerts.thresholds import SPECS, store_after_ai_accepted
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import AuditLog, RoleName, User


router = APIRouter(prefix="/ai/config", tags=["AI config"])

# Site-wide detector tuning: not per agency, and a bad value changes what
# every branch's cameras detect, so ADMIN only.
CONFIG_ROLES = [Depends(require_roles(RoleName.ADMIN))]

# GET /config on the AI service also reports where it keeps files on its own
# disk. Nothing in the UI needs those, so they are not passed on.
HIDDEN_KEYS = ("config_file", "data_dir", "models_dir")


class ConfigPatch(BaseModel):
    changes: dict[str, dict[str, Any]]
    persist: bool = False


def _audit(db: Session, user: User, action: str, details: dict) -> None:
    db.add(
        AuditLog(
            user_id=user.id,
            action=action,
            entity_type="ai_config",
            details=details,
        )
    )
    db.commit()


def _keep_thresholds(db: Session, payload: ConfigPatch) -> None:
    """A key that is also an alert threshold is stored, so it survives an AI
    restart exactly like a change made on that threshold's own page."""
    for alert_type, spec in SPECS.items():
        value = payload.changes.get(spec.section, {}).get(spec.key)
        if value is not None:
            store_after_ai_accepted(db, alert_type, value)


@router.get("", dependencies=CONFIG_ROLES)
def get_config(current_user: User = Depends(get_current_user)) -> dict:
    response = forward("GET", "/config")
    raise_for_ai_status(response)
    body = response.json()
    return {key: value for key, value in body.items() if key not in HIDDEN_KEYS}


@router.patch("", dependencies=CONFIG_ROLES)
def patch_config(
    payload: ConfigPatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    response = forward("PATCH", "/config", json=payload.model_dump())
    raise_for_ai_status(response)
    result = response.json()
    _keep_thresholds(db, payload)
    _audit(
        db,
        current_user,
        "ai_config_changed",
        {"changes": payload.changes, "persist": payload.persist, "previous": result.get("previous")},
    )
    return result


@router.post("/reload", dependencies=CONFIG_ROLES)
def reload_config(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    response = forward("POST", "/config/reload")
    raise_for_ai_status(response)
    result = response.json()
    _audit(db, current_user, "ai_config_reloaded", {"applied": result.get("applied")})
    return result
