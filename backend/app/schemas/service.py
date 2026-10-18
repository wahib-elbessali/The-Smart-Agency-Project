from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


PointType = Literal["COUNTER", "OFFICE"]


class ServiceCreate(BaseModel):
    code: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=500)
    point_type: PointType = "COUNTER"
    min_points: int = Field(default=1, ge=1, le=100)
    is_active: bool = True


class ServiceUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    name: str | None = Field(default=None, min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=500)
    point_type: PointType | None = None
    min_points: int | None = Field(default=None, ge=1, le=100)
    is_active: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_null_for_required_fields(cls, values):
        """Keep omitted fields optional, but reject explicit null values.

        ``PUT`` is a partial update in this API. The database columns for
        ``code``, ``name``, ``point_type``, ``min_points`` and ``is_active``
        are not nullable, so accepting JSON ``null`` here would either cause
        an AttributeError during normalization or a misleading database error.
        ``description`` is intentionally excluded because null clears it.
        """
        if isinstance(values, dict):
            non_nullable = ("code", "name", "point_type", "min_points", "is_active")
            invalid = [field for field in non_nullable if field in values and values[field] is None]
            if invalid:
                fields = ", ".join(invalid)
                raise ValueError(f"Les champs suivants ne peuvent pas etre null: {fields}")
        return values


class ServiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str
    code: str
    name: str
    description: str | None
    point_type: PointType
    min_points: int
    is_active: bool


class ServicePointResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    agency_id: str
    service_id: str | None
    number: int
    name: str | None
    point_type: PointType
    is_open: bool


class CounterServiceAssignment(BaseModel):
    service_id: str | None = None
