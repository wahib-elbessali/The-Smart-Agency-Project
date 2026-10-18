from datetime import datetime

from pydantic import BaseModel, Field


class VisitorCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    identity_reference: str | None = Field(default=None, max_length=100)
    agency_id: str | None = None


class VisitorResponse(BaseModel):
    id: str
    agency_id: str
    full_name: str
    phone: str | None
    identity_reference: str | None
    created_at: datetime
