from typing import Any

from pydantic import BaseModel, Field


class TicketTemplateUpdate(BaseModel):
    template: list[dict[str, Any]] = Field(min_length=1)


class TicketTemplateResponse(BaseModel):
    template: list[dict[str, Any]]
