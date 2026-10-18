from urllib.parse import urlparse

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.entities import DeviceStatus


# The AI service opens whatever URL it is given, so a stream URL must be a
# network video address, never a local file path or another scheme.
STREAM_SCHEMES = ("rtsp", "rtsps", "http", "https")


def check_stream_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value.strip())
    if parsed.scheme.lower() not in STREAM_SCHEMES or not parsed.hostname:
        raise ValueError("Le flux doit etre une adresse rtsp://, rtsps://, http:// ou https://")
    return value


CameraFeature = Literal["weapon", "fire", "wanted", "emotion"]


def dedupe_features(value: list[str] | None) -> list[str] | None:
    return None if value is None else list(dict.fromkeys(value))


class CameraCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    stream_url: str = Field(min_length=1, max_length=500)
    # Omitted or null = every detection; [] = none.
    ai_features: list[CameraFeature] | None = None

    _features = field_validator("ai_features")(dedupe_features)

    _stream_url = field_validator("stream_url")(check_stream_url)


class CameraUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    stream_url: str | None = Field(default=None, min_length=1, max_length=500)
    ai_features: list[CameraFeature] | None = None

    _features = field_validator("ai_features")(dedupe_features)

    _stream_url = field_validator("stream_url")(check_stream_url)


class CameraResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str
    name: str
    stream_url: str | None
    status: DeviceStatus
    ai_features: list[str] | None = None


class AIWeaponThresholdRequest(BaseModel):
    confidence: float = Field(gt=0, le=1)


class AIWeaponThresholdResponse(BaseModel):
    confidence: float
