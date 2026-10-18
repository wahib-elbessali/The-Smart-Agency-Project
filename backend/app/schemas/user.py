from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=150)
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=8, max_length=72)
    role: str = Field(default="AGENT", max_length=20)
    agency_id: str | None = None
    employee_id: str | None = None


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=150)
    email: str | None = Field(default=None, min_length=5, max_length=255)
    password: str | None = Field(default=None, min_length=8, max_length=72)
    is_active: bool | None = None
    employee_id: str | None = None


class RoleUpdate(BaseModel):
    role: str = Field(max_length=20)


class AgencyAssignment(BaseModel):
    agency_id: str | None = None


class AccessUpdate(BaseModel):
    role: str = Field(max_length=20)
    agency_id: str | None = None


class EmployeeLinkResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    first_name: str
    last_name: str
    agency_id: str
    rfid_uid: str | None
    role: str
    authorized_zone_ids: list[str]


class UserResponse(BaseModel):
    id: str
    full_name: str
    email: str
    role: str
    agency_id: str | None
    employee_id: str | None
    is_active: bool
    employee: EmployeeLinkResponse | None = None
