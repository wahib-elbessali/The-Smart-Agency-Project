from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class TicketCreate(BaseModel):
    visitor_id: str
    service_id: str
    service_type: str | None = Field(default=None, max_length=100)


class TicketCallRequest(BaseModel):
    counter_id: str


class TicketCompleteRequest(BaseModel):
    notes: str | None = Field(default=None, max_length=2000)


class TicketResponse(BaseModel):
    id: str
    visitor_id: str
    visitor_name: str
    agency_id: str
    service_id: str | None
    service_code: str | None
    service_name: str | None
    counter_id: str | None
    ticket_number: str
    service_type: str | None
    status: Literal["WAITING", "CALLED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"]
    created_at: datetime
    called_at: datetime | None
    in_service_at: datetime | None
    completed_at: datetime | None
    notes: str | None
    tracking_id: str | None


class TrackedTicketResponse(BaseModel):
    """GET /tickets/tracked - for the live map (Tracking.tsx) to relabel a
    tracked person by ticket number instead of a bare AI track id."""

    ticket_id: str
    ticket_number: str
    tracking_id: str


class PreviousVisit(BaseModel):
    ticket_number: str
    service_name: str | None
    status: str
    created_at: datetime
    notes: str | None


class VisitorHistoryResponse(BaseModel):
    """GET /tickets/{id}/history - earlier visits of the same face."""

    recognised: bool
    previous_visits: list[PreviousVisit]
