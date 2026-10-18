from pydantic import BaseModel, ConfigDict, Field, model_validator


class SensorThresholdUpsert(BaseModel):
    unit: str | None = Field(default=None, max_length=20)
    warning_max: float | None = None
    critical_max: float | None = None
    is_active: bool = True

    @model_validator(mode="after")
    def validate_limits(self):
        if self.warning_max is None and self.critical_max is None:
            raise ValueError("warning_max ou critical_max est obligatoire")
        if (
            self.warning_max is not None
            and self.critical_max is not None
            and self.warning_max > self.critical_max
        ):
            raise ValueError("warning_max doit etre inferieur ou egal a critical_max")
        return self


class SensorThresholdResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    device_id: str
    sensor_type: str
    unit: str | None
    warning_max: float | None
    critical_max: float | None
    is_active: bool
