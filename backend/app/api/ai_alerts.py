from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.classifier import (
    DEFAULT_WEAPON_THRESHOLD,
    definir_seuil_confiance_arme,
)
from app.ai_alerts.thresholds import update_threshold
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import AIAlertThreshold, RoleName, User
from app.schemas.camera import AIWeaponThresholdRequest, AIWeaponThresholdResponse


router = APIRouter(prefix="/ai-alerts/thresholds", tags=["AI alert thresholds"])
AI_THRESHOLD_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))
]


def get_or_create_weapon_threshold(db: Session) -> AIAlertThreshold:
    threshold = db.scalar(
        select(AIAlertThreshold).where(AIAlertThreshold.alert_type == "weapon")
    )
    if threshold is None:
        threshold = AIAlertThreshold(
            alert_type="weapon",
            confidence=DEFAULT_WEAPON_THRESHOLD,
        )
        db.add(threshold)
        db.commit()
        db.refresh(threshold)
    definir_seuil_confiance_arme(threshold.confidence)
    return threshold


@router.get(
    "/weapon",
    response_model=AIWeaponThresholdResponse,
    dependencies=AI_THRESHOLD_ROLES,
)
def get_weapon_threshold(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AIWeaponThresholdResponse:
    threshold = get_or_create_weapon_threshold(db)
    return AIWeaponThresholdResponse(confidence=threshold.confidence)


@router.put(
    "/weapon",
    response_model=AIWeaponThresholdResponse,
    dependencies=AI_THRESHOLD_ROLES,
)
def update_weapon_threshold(
    payload: AIWeaponThresholdRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AIWeaponThresholdResponse:
    # The detector in the AI service follows the same value, and the stored
    # copy is pushed again whenever the AI service restarts. The backend filter
    # does not need the AI service, so saving works while it is unreachable.
    confidence = update_threshold(db, "weapon", payload.confidence, require_ai=False)
    return AIWeaponThresholdResponse(confidence=confidence)
