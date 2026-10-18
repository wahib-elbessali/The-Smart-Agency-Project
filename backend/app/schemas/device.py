from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.entities import DeviceStatus


class DeviceCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    device_type: str = Field(min_length=2, max_length=80)
    mqtt_client_id: str = Field(min_length=2, max_length=150)
    mqtt_topic: str | None = Field(default=None, max_length=255)


class DeviceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    device_type: str | None = Field(default=None, min_length=2, max_length=80)
    mqtt_client_id: str | None = Field(default=None, min_length=2, max_length=150)
    mqtt_topic: str | None = Field(default=None, max_length=255)
    status: DeviceStatus | None = None
    # Which AI-service zone this reader's badge scans correlate against for
    # the live-map employee tracking link (Phase F) - manager-set, no
    # dedicated UI yet, same precedent as every per-device/per-agency
    # setting this backlog has shipped.
    badge_zone_name: str | None = None
    heartbeat_seconds: int | None = Field(default=None, ge=10)


class DeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str
    name: str
    device_type: str
    mqtt_client_id: str
    mqtt_topic: str
    status: DeviceStatus
    last_seen_at: datetime | None
    badge_zone_name: str | None = None
    heartbeat_seconds: int | None = None


class DeviceRegistrationResponse(DeviceResponse):
    device_key: str
