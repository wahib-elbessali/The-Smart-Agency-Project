from datetime import datetime
from pydantic import BaseModel, Field


class AttendanceEventRequest(BaseModel):
    employee_rfid: str = Field(min_length=1, max_length=100)
    timestamp: datetime | None = None
    agency_id: str | None = None


class MqttAttendanceMessage(BaseModel):
    employee_rfid: str = Field(min_length=1, max_length=100)
    timestamp: datetime | None = None


class AttendanceResponse(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    agency_id: str
    check_in: datetime
    check_out: datetime | None
    method: str
