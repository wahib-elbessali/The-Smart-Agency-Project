"""Wanted-person alerts. Same shape as WeaponAlertConsumer, no business
threshold layer on top - the AI service already exposes its own adjustable
match threshold (PUT /watchlist/threshold, proxied in api/watchlist.py),
so there's no second one to duplicate here.

`confidence` here is a cosine similarity against the watchlist gallery, not
a probability - worded as a raw score, never rendered as a percentage
(same rule the frontend's Alerts screen follows for the same field)."""

from app.ai_alerts.base_consumer import GenericAlertConsumer
from app.models.entities import AlertSeverity


def _build_message(detections: list[dict]) -> str:
    details = ", ".join(f"{d['class']} (score {d['confidence']:.2f})" for d in detections)
    return f"Personne recherchee detectee: {details}"


wanted_alert_consumer = GenericAlertConsumer(
    alert_type="wanted",
    stream_path="/wanted/alerts/stream",
    sources_path="/wanted/sources",
    thread_name="wanted-alert-consumer",
    alert_title="Personne recherchee",
    build_message=_build_message,
    severity=AlertSeverity.CRITICAL,
)
