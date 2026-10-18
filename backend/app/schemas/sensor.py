from datetime import datetime

from pydantic import BaseModel, Field


class SensorReadingPayload(BaseModel):
    sensor_type: str = Field(min_length=1, max_length=80)
    value: float
    unit: str | None = Field(default=None, max_length=20)


class SensorPayload(BaseModel):
    readings: list[SensorReadingPayload] = Field(min_length=1, max_length=50)
    timestamp: datetime


class LatestReading(BaseModel):
    """One device's most recent value for one sensor_type - the read side
    ingestion never had. process_sensor_payload() already writes every
    reading to SensorReading; nothing anywhere read it back out."""

    device_id: str
    device_name: str
    sensor_type: str
    value: float
    unit: str | None
    recorded_at: datetime
