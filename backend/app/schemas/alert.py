from datetime import datetime

from pydantic import BaseModel

from app.models.entities import AlertSeverity, AlertStatus


class AlertResponse(BaseModel):
    id: str
    agency_id: str
    camera_id: str | None
    camera_name: str | None
    device_id: str | None = None
    device_name: str | None = None
    alert_type: str
    title: str | None = None
    message: str | None = None
    severity: AlertSeverity
    status: AlertStatus
    created_at: datetime
    resolved_at: datetime | None
    # intrusion alerts: the tracked person it is about
    tracking_id: str | None = None
