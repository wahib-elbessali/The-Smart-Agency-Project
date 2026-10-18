from typing import Literal

from pydantic import BaseModel


class SetupItem(BaseModel):
    key: str
    group: str
    label: str
    why: str
    status: Literal["done", "todo", "unknown"]
    detail: str
    # The screen where the step is done. None = on the branch page itself.
    link: str | None


class SetupStatus(BaseModel):
    items: list[SetupItem]
    done: int
    total: int
    # Every step done. "unknown" (the AI service could not be asked) is not done.
    complete: bool
