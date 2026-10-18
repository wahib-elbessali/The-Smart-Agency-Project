"""Camera security alerts as incidents, not per-camera blips.

Two rules, both from the 2026-10-18 day test:

- STICKY: a weapon or a watchlist match is closed by a person, never by the
  camera clearing. An armed visitor who ran out of view resolved his own
  alert 2 minutes later, unacknowledged. When the camera clears, the alert
  stays active and says since when the subject is out of view.
- ONE INCIDENT: one person seen by two cameras opened two alerts. A camera
  with no active alert of its own now joins the branch's active incident of
  the same kind (any weapon; the same wanted name) instead of opening one.

Fire and smoke keep the plain per-camera behaviour: smoke that is gone is
over, and each camera's view of a fire is its own question.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Alert, AlertStatus

STICKY_ALERT_TYPES = frozenset({"weapon", "wanted"})
ACTIVE = (AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)
OUT_OF_VIEW = " - plus visible depuis "


def incident_title(alert_type: str, base_title: str, detections: list[dict]) -> str:
    """A wanted incident is about one name (or set of names); a weapon one is
    simply "a weapon in the branch"."""
    if alert_type != "wanted":
        return base_title
    names = sorted({str(d.get("class")) for d in detections if d.get("class")})
    return f"{base_title}: {', '.join(names)}" if names else base_title


def find_incident(db: Session, agency_id: str, alert_type: str, title: str) -> Alert | None:
    query = select(Alert).where(
        Alert.agency_id == agency_id,
        Alert.alert_type == alert_type,
        Alert.status.in_(ACTIVE),
    )
    if alert_type == "wanted":
        query = query.where(Alert.title == title)
    return db.scalar(query.order_by(Alert.created_at.desc()))


def mark_out_of_view(alert: Alert, camera_name: str) -> bool:
    """Note that the subject left this camera's view; the alert stays open.
    Returns whether anything changed."""
    if OUT_OF_VIEW in alert.message:
        return False
    when = datetime.now(timezone.utc).strftime("%H:%M")
    alert.message = f"{alert.message}{OUT_OF_VIEW}{when} UTC ({camera_name})"
    return True
