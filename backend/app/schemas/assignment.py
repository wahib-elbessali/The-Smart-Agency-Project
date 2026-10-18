from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class AgentAssignmentResponse(BaseModel):
    counter_id: str
    counter_name: str | None
    service_id: str
    service_name: str
    no_show_min_wait_seconds: int


class AgentAttendance(BaseModel):
    """Today's badge state for an agent who has a linked Employee. "unavailable"
    means the RFID feed itself is down (the MQTT broker is), so absence of a
    badge-in proves nothing and must not be flagged."""

    state: Literal["checked_in", "checked_out", "not_checked_in", "unavailable"]
    at: datetime | None = None


class AgentSummaryResponse(BaseModel):
    user_id: str
    full_name: str
    # AGENT or MANAGER: a manager can cover a counter too.
    role: str | None = None
    assignment: AgentAssignmentResponse | None
    # None = this agent has no linked Employee, so there is nothing to check.
    attendance: AgentAttendance | None = None


class AgentAssignmentUpdate(BaseModel):
    counter_id: str | None
