"""Fire/smoke alerts. Same shape as WeaponAlertConsumer, no business
threshold layer on top - a fire detection is alert-worthy the moment the AI
service reports one, there's nothing to tune the way weapon's confidence is."""

from app.ai_alerts.base_consumer import GenericAlertConsumer
from app.models.entities import AlertSeverity


def _build_message(detections: list[dict]) -> str:
    details = ", ".join(f"{d['class']} ({d['confidence']:.2f})" for d in detections)
    return f"Incendie ou fumee detecte: {details}"


fire_alert_consumer = GenericAlertConsumer(
    alert_type="fire",
    stream_path="/fire/alerts/stream",
    sources_path="/fire/sources",
    thread_name="fire-alert-consumer",
    alert_title="Incendie detecte",
    build_message=_build_message,
    severity=AlertSeverity.CRITICAL,
)
