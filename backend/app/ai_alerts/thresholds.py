"""Alert thresholds that live in both Postgres and the AI service.

Postgres (`ai_alert_thresholds`) is the durable copy. The AI service holds the
running copy, changed through its live config API (`PATCH /config`, never
persisted there), so it forgets the value when it restarts. Each consumer
therefore calls `restore_thresholds` every time it (re)connects to the AI
service, which puts the stored value back.

Only features with an admin-editable threshold are listed in SPECS. Each key
is independent: a change touches only its own `section.key` in the AI service.
"""

import logging
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.ai_alerts.classifier import DEFAULT_WEAPON_THRESHOLD, definir_seuil_confiance_arme
from app.database.connection import SessionLocal
from app.models.entities import AIAlertThreshold

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ThresholdSpec:
    section: str
    key: str
    minimum: float
    minimum_inclusive: bool
    # Used while nothing is stored. None: the AI service's own config.json wins.
    default: float | None
    # Backend-side copy that must follow the stored value (weapon's filter).
    mirror: Callable[[float], object] | None = None


SPECS: dict[str, ThresholdSpec] = {
    "weapon": ThresholdSpec(
        "weapon", "conf", 0.0, False, DEFAULT_WEAPON_THRESHOLD, definir_seuil_confiance_arme
    ),
    "fire": ThresholdSpec("fire", "conf", 0.0, False, None),
    # Same floor as the AI service: below it open-set matching false-alarms constantly.
    "wanted": ThresholdSpec("wanted", "threshold", 0.25, True, None),
}


def validate(alert_type: str, value: object) -> float:
    """The AI service's own bounds, checked before any call is made."""
    spec = SPECS[alert_type]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(422, f"Le seuil {alert_type} doit etre un nombre")
    number = float(value)
    too_low = number < spec.minimum or (number == spec.minimum and not spec.minimum_inclusive)
    if not math.isfinite(number) or too_low or number > 1:
        bracket = "[" if spec.minimum_inclusive else "]"
        raise HTTPException(422, f"Le seuil {alert_type} doit etre dans {bracket}{spec.minimum}, 1]")
    return number


def stored_value(db: Session, alert_type: str) -> float | None:
    row = db.scalar(select(AIAlertThreshold).where(AIAlertThreshold.alert_type == alert_type))
    return row.confidence if row is not None else SPECS[alert_type].default


def _store(db: Session, alert_type: str, value: float) -> None:
    row = db.scalar(select(AIAlertThreshold).where(AIAlertThreshold.alert_type == alert_type))
    if row is None:
        db.add(AIAlertThreshold(alert_type=alert_type, confidence=value))
    else:
        row.confidence = value
    db.commit()


def _push(spec: ThresholdSpec, value: float) -> httpx.Response:
    return forward("PATCH", "/config", json={"changes": {spec.section: {spec.key: value}}, "persist": False})


def update_threshold(db: Session, alert_type: str, value: object, *, require_ai: bool) -> float:
    """Validate, apply to the AI service, then store.

    The AI service refusing the value (422) stops everything, so Postgres never
    holds a value the AI would not take. With `require_ai=False` an unreachable
    AI service does not block saving (weapon's backend filter works without
    it); the stored value is pushed on the next reconnect.
    """
    spec = SPECS[alert_type]
    number = validate(alert_type, value)
    try:
        raise_for_ai_status(_push(spec, number))
    except HTTPException as error:
        if not (error.status_code == 503 and not require_ai):
            raise
        logger.warning("Seuil %s enregistre, AI injoignable: restaure a la reconnexion", alert_type)
    _store(db, alert_type, number)
    if spec.mirror is not None:
        spec.mirror(number)
    return number


def store_after_ai_accepted(db: Session, alert_type: str, value: object) -> None:
    """For a route that already pushed `value` to the AI service itself."""
    number = validate(alert_type, value)
    _store(db, alert_type, number)
    mirror = SPECS[alert_type].mirror
    if mirror is not None:
        mirror(number)


def restore_thresholds(alert_types: Iterable[str]) -> bool:
    """Put the stored values back into a (re)started AI service.

    Returns False when the AI service or the database is unreachable so the
    consumer retries after its usual delay. A refusal from the AI service is
    logged and skipped: the stream must not stall on one bad value.
    """
    for alert_type in alert_types:
        spec = SPECS.get(alert_type)
        if spec is None:
            continue
        db = SessionLocal()
        try:
            value = stored_value(db, alert_type)
        except Exception:
            logger.warning("Seuil %s persiste indisponible", alert_type)
            return False
        finally:
            db.close()
        if value is None:
            continue
        if spec.mirror is not None:
            spec.mirror(value)
        try:
            response = _push(spec, value)
        except HTTPException as error:
            if error.status_code == 503:
                logger.warning("Seuil %s non restaure dans l'AI: injoignable", alert_type)
                return False
            logger.error("Seuil %s non restaure dans l'AI: %s", alert_type, error.detail)
            continue
        if response.status_code >= 400:
            logger.error("Seuil %s refuse par l'AI (%s): %s", alert_type, response.status_code, response.text)
    return True
