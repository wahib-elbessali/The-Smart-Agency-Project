from pydantic import BaseModel, Field


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=255)
    auth: str = Field(min_length=1, max_length=255)


class PushSubscriptionCreate(BaseModel):
    """The shape of the browser's PushSubscription.toJSON()."""

    endpoint: str = Field(min_length=1, max_length=2048)
    keys: PushKeys


class PushPublicKeyResponse(BaseModel):
    public_key: str | None
    push_enabled: bool
