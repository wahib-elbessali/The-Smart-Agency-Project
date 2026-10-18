from pydantic import BaseModel, Field


class ManualControlRequest(BaseModel):
    action: str = Field(min_length=1, max_length=50)
    # e.g. which door/lock/motor on a device that controls more than one -
    # optional, most devices won't need it.
    target: str | None = Field(default=None, max_length=100)


class ManualControlResult(BaseModel):
    status: str  # "confirmed" | "failed" | "unknown"
    detail: str | None = None
