from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AnnouncementCreate(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    message: str = Field(min_length=1, max_length=4000)
    # None means site-wide - only an ADMIN may send one of those, checked
    # in the route, not here.
    agency_id: str | None = None


class AnnouncementResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str | None
    author_id: str | None
    title: str
    message: str
    created_at: datetime
