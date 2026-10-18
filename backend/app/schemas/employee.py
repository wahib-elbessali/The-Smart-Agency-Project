from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class EmployeeCreate(BaseModel):
    first_name: str = Field(min_length=2, max_length=100)
    last_name: str = Field(min_length=2, max_length=100)
    email: str | None = Field(default=None, min_length=5, max_length=255)
    phone: str | None = Field(default=None, max_length=30)
    position: str | None = Field(default=None, max_length=100)
    agency_id: str | None = None
    rfid_uid: str | None = Field(default=None, max_length=100)
    role: str = Field(default="AGENT", max_length=20)
    authorized_zone_ids: list[str] = Field(default_factory=list)
    status: str = Field(default="ACTIVE", max_length=20)
    hire_date: date | None = None


class EmployeeUpdate(BaseModel):
    first_name: str | None = Field(default=None, min_length=2, max_length=100)
    last_name: str | None = Field(default=None, min_length=2, max_length=100)
    email: str | None = Field(default=None, min_length=5, max_length=255)
    phone: str | None = Field(default=None, max_length=30)
    position: str | None = Field(default=None, max_length=100)
    agency_id: str | None = None
    rfid_uid: str | None = Field(default=None, max_length=100)
    role: str | None = Field(default=None, max_length=20)
    authorized_zone_ids: list[str] | None = None
    status: str | None = Field(default=None, max_length=20)
    hire_date: date | None = None


class EmployeeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str
    first_name: str
    last_name: str
    email: str | None
    phone: str | None
    position: str | None
    rfid_uid: str | None
    role: str
    authorized_zone_ids: list[str]
    status: str
    hire_date: date | None
    is_active: bool


class TrackedEmployeeResponse(BaseModel):
    """GET /employees/tracked (Phase F) - for the live map (Tracking.tsx)
    to relabel a tracked dot by employee name instead of a bare AI track
    id. Employees have no terminal status the way tickets do, so this is
    every currently-linked employee as-is - including the accepted
    staleness trade-off (see people_tracking.py's module docstring)."""

    employee_id: str
    full_name: str
    tracking_id: str
