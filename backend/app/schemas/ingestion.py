from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class WalkInVisitor(BaseModel):
    full_name: str = Field(default="Visiteur borne", min_length=2, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    identity_reference: str | None = Field(default=None, max_length=100)


class WalkInTicketRequest(BaseModel):
    agency_id: str
    device_id: str
    service_id: str | None = None
    service_type: str | None = Field(default=None, max_length=100)
    visitor: WalkInVisitor | None = None
    timestamp: datetime | None = None


class WalkInTicketResponse(BaseModel):
    ticket_id: str
    ticket_number: str
    service_id: str
    service_type: str
    status: Literal["WAITING"] = "WAITING"


class KioskServiceResponse(BaseModel):
    service_id: str
    code: str
    name: str
    counter_id: str | None = None


class KioskMessages(BaseModel):
    error_line1: str = "Erreur reseau"
    error_line2: str = "Reessayez"
    no_service_line1: str = "Aucun service"
    no_service_line2: str = "disponible"


class KioskConfigResponse(BaseModel):
    services: list[KioskServiceResponse]
    messages: KioskMessages


class CallNextRequest(BaseModel):
    agency_id: str
    device_id: str
    service_id: str
    counter_id: str


class CallNextResponse(BaseModel):
    called: bool
    ticket_id: str | None = None
    ticket_number: str | None = None
    service_code: str


class RFIDCheckRequest(BaseModel):
    agency_id: str
    device_id: str
    employee_rfid: str = Field(min_length=1, max_length=100)
    timestamp: datetime | None = None


class RFIDCheckResponse(BaseModel):
    valid: bool
    employee_name: str | None = None
    event: Literal["check_in", "check_out"] | None = None
    message: str | None = None


class DoorAccessRequest(BaseModel):
    agency_id: str
    device_id: str
    employee_rfid: str = Field(min_length=1, max_length=100)
    zone_id: str
    timestamp: datetime | None = None


class DoorAccessResponse(BaseModel):
    authorized: bool
    employee_name: str | None = None
    employee_role: str | None = None
    zone_id: str
    message: str | None = None
