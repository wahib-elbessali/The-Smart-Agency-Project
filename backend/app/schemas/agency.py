from datetime import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.service import PointType


class ZoneCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    zone_type: str = Field(default="PUBLIC", max_length=50)
    is_private: bool = False
    # "rfid" or "rfid_face" (badge + the badge holder's face at door_camera_id).
    access_mode: Literal["rfid", "rfid_face"] = "rfid"
    door_camera_id: str | None = None


class ZoneResponse(ZoneCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str


class ZoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    zone_type: str | None = Field(default=None, max_length=50)
    is_private: bool | None = None
    access_mode: Literal["rfid", "rfid_face"] | None = None
    door_camera_id: str | None = None


class CounterCreate(BaseModel):
    number: int = Field(ge=1)
    name: str | None = Field(default=None, max_length=100)
    point_type: PointType = "COUNTER"
    is_open: bool = True


class CounterResponse(CounterCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    service_id: str | None = None
    emotion_camera_id: str | None = None
    workstation_name: str | None = None


# A counter used to be writable only once, inside
# AgencyCreate, at the moment a branch was first made - there was no route to
# add, rename, or close one afterward. This is that route's body: every
# field optional so a caller changes only what it means to (a rename should
# not silently reopen a closed counter it didn't ask about).
class CounterUpdate(BaseModel):
    number: int | None = Field(default=None, ge=1)
    name: str | None = Field(default=None, max_length=100)
    is_open: bool | None = None
    emotion_camera_id: str | None = None
    workstation_name: str | None = Field(default=None, max_length=150)


class AgencyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    address: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=30)
    opening_time: time | None = None
    closing_time: time | None = None
    zones: list[ZoneCreate] = Field(default_factory=list)
    counters: list[CounterCreate] = Field(default_factory=list)


class AgencyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    address: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=30)
    opening_time: time | None = None
    closing_time: time | None = None
    is_active: bool | None = None
    no_show_min_wait_seconds: int | None = Field(default=None, ge=0)
    kiosk_zone_name: str | None = None
    kiosk_face_camera_id: str | None = None
    weapon_lockdown_enabled: bool | None = None
    access_failure_threshold: int | None = Field(default=None, ge=1)
    access_failure_window_minutes: int | None = Field(default=None, ge=1, le=1440)

    @field_validator(
        "is_active", "no_show_min_wait_seconds", "weapon_lockdown_enabled", "access_failure_window_minutes"
    )
    @classmethod
    def not_null_when_sent(cls, value):
        # These columns are NOT NULL. Leaving a key out means "unchanged"; sending an
        # explicit null used to reach the database and come back as a 500.
        if value is None:
            raise ValueError("cannot be null")
        return value
    queue_depth_warning: int | None = Field(default=None, ge=1)
    queue_depth_critical: int | None = Field(default=None, ge=1)
    oldest_wait_warning_seconds: int | None = Field(default=None, ge=1)
    oldest_wait_critical_seconds: int | None = Field(default=None, ge=1)


class AgencyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    address: str | None
    phone: str | None
    opening_time: time | None
    closing_time: time | None
    is_active: bool
    no_show_min_wait_seconds: int
    kiosk_zone_name: str | None
    kiosk_face_camera_id: str | None = None
    weapon_lockdown_enabled: bool
    access_failure_threshold: int | None
    access_failure_window_minutes: int
    queue_depth_warning: int | None
    queue_depth_critical: int | None
    oldest_wait_warning_seconds: int | None
    oldest_wait_critical_seconds: int | None
    zones: list[ZoneResponse] = Field(default_factory=list)
    counters: list[CounterResponse] = Field(default_factory=list)
    employees_count: int = 0
    devices_count: int = 0
    cameras_count: int = 0
