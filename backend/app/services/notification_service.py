"""CRITICAL-alert notifications: Web Push first, email for anyone push can't reach.

Scenario-planning backlog, "Unified notification policy". Called from the
places that create an Alert row (the AI consumers and the MQTT sensor path),
once, when a CRITICAL alert is newly opened - never when an already-open alert
is merely refreshed, or a detection that persists for a minute would send a
notification a second.

Runs on the caller's own background thread (consumer / paho thread), so plain
blocking I/O is fine. Nothing here may ever raise into the caller: a broken
SMTP server must not stop an alert from being recorded or a door from locking.
"""

import json
import logging
import smtplib
import threading
from email.message import EmailMessage

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import (
    Alert,
    AlertSeverity,
    AlertStatus,
    PushSubscription,
    Role,
    RoleName,
    User,
)


logger = logging.getLogger(__name__)

NOTIFIED_ROLES = (RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY)


class PushGone(Exception):
    """The push service says this subscription no longer exists (404/410)."""


def push_configured() -> bool:
    return bool(settings.vapid_private_key and settings.vapid_public_key)


def email_configured() -> bool:
    return bool(settings.smtp_host)


def _send_push(subscription: PushSubscription, payload: dict) -> None:
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={
                "endpoint": subscription.endpoint,
                "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
            },
            data=json.dumps(payload),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
            ttl=3600,
            timeout=10,
        )
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            raise PushGone() from exc
        raise


def _send_email(to_address: str, subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = to_address
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        if settings.smtp_use_tls:
            smtp.starttls()
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password or "")
        smtp.send_message(message)


def recipients_for(db: Session, agency_id: str) -> list[User]:
    """Active ADMINs (they span every agency) plus the alert agency's own
    MANAGERs and SECURITY staff."""
    users = db.scalars(
        select(User)
        .join(Role, User.role_id == Role.id)
        .where(User.is_active.is_(True), Role.name.in_(NOTIFIED_ROLES))
    ).all()
    return [
        user
        for user in users
        if user.role.name == RoleName.ADMIN or user.agency_id == agency_id
    ]


HAZARD_COUNTERPART = {"fire": "gas_co", "gas_co": "fire"}


def _corroboration(db: Session, alert: Alert) -> str | None:
    """Fire and gas_co are independent signals (a camera and a sensor). When the
    other one is also open in the same agency the notification says so - a
    labeling boost only, never a gate on notifying or unlocking."""
    other = HAZARD_COUNTERPART.get(alert.alert_type)
    if other is None:
        return None
    found = db.scalar(
        select(Alert.id).where(
            Alert.agency_id == alert.agency_id,
            Alert.alert_type == other,
            Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
        )
    )
    return other if found is not None else None


def _payload(alert: Alert, corroborated_by: str | None = None, hazard_open: str | None = None) -> dict:
    title, body = alert.title, alert.message
    if hazard_open is not None:
        body = f"{body} (a {hazard_open} alert is also open here: automatic lock is held back while it is open)"
    if corroborated_by is not None:
        title = f"CORROBORATED - {title}"
        body = f"{body} (also open in this agency: {corroborated_by} alert)"
    return {
        "title": title,
        "body": body,
        "alert_id": alert.id,
        "alert_type": alert.alert_type,
        "severity": alert.severity.value,
        "url": "/alerts",
    }


def _notify_one(db: Session, alert: Alert) -> None:
    hazard_open = None
    if alert.alert_type == "weapon":
        hazard_open = db.scalar(
            select(Alert.alert_type).where(
                Alert.agency_id == alert.agency_id,
                Alert.alert_type.in_(("fire", "gas_co")),
                Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
            )
        )
    payload = _payload(alert, _corroboration(db, alert), hazard_open)
    for user in recipients_for(db, alert.agency_id):
        delivered = False
        if push_configured():
            for subscription in list(
                db.scalars(
                    select(PushSubscription).where(PushSubscription.user_id == user.id)
                )
            ):
                try:
                    _send_push(subscription, payload)
                    delivered = True
                except PushGone:
                    db.delete(subscription)
                except Exception:
                    logger.exception("push to user %s failed", user.id)
        if not delivered and email_configured():
            try:
                _send_email(
                    user.email,
                    f"[{alert.severity.value}] {payload['title']}",
                    f"{payload['body']}\n\nAlert type: {alert.alert_type}\nAgency: {alert.agency_id}",
                )
            except Exception:
                logger.exception("email to user %s failed", user.id)
    db.commit()


def notify_critical_alerts(alert_ids: list[str]) -> None:
    """Never raises, never blocks the caller. CRITICAL only - anything else
    stays dashboard-only. Delivery runs on its own thread: a slow push service
    or SMTP server (10 s timeouts, per recipient) must not stall the MQTT or AI
    consumer thread that called this - that thread is the one receiving the
    incident."""
    if not alert_ids or not settings.notifications_enabled:
        return
    try:
        threading.Thread(
            target=_deliver, args=(list(alert_ids),), name="critical-notify", daemon=True
        ).start()
    except Exception:
        logger.exception("could not start notification thread")


def _deliver(alert_ids: list[str]) -> None:
    db = SessionLocal()
    try:
        for alert_id in alert_ids:
            alert = db.get(Alert, alert_id)
            if alert is None or alert.severity != AlertSeverity.CRITICAL:
                continue
            try:
                _notify_one(db, alert)
            except Exception:
                db.rollback()
                logger.exception("notification for alert %s failed", alert_id)
    except Exception:
        logger.exception("notification pipeline failed")
    finally:
        db.close()
