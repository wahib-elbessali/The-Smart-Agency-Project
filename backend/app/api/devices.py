from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.core.device_security import generate_device_key, hash_device_key
from app.database.connection import get_db
from app.models.entities import Agency, AuditLog, Device, DeviceStatus, RoleName, User
from app.schemas.device import DeviceCreate, DeviceRegistrationResponse, DeviceResponse, DeviceUpdate


router = APIRouter(prefix="/devices", tags=["Devices"])
DEVICE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.TECHNICIAN))]


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def get_agency_or_404(agency_id: str, db: Session) -> Agency:
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    return agency


def get_device_or_404(device_id: str, db: Session) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Appareil introuvable")
    return device


def default_topic(agency_id: str, mqtt_client_id: str) -> str:
    return f"agency/{agency_id}/device/{mqtt_client_id}/sensor"


@router.get("", response_model=list[DeviceResponse], dependencies=DEVICE_ROLES)
def list_devices(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DeviceResponse]:
    query = select(Device).order_by(Device.name)
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(Device.agency_id == current_user.agency_id)
    return list(db.scalars(query).all())


@router.post(
    "/agencies/{agency_id}",
    response_model=DeviceRegistrationResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=DEVICE_ROLES,
)
def register_device(
    agency_id: str,
    payload: DeviceCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceRegistrationResponse:
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency.id, current_user)
    if not agency.is_active:
        raise HTTPException(status_code=409, detail="Impossible d enregistrer un appareil dans une agence inactive")

    client_id = payload.mqtt_client_id.strip()
    device_key = generate_device_key()
    device = Device(
        agency_id=agency_id,
        name=payload.name.strip(),
        device_type=payload.device_type.strip().upper(),
        mqtt_client_id=client_id,
        mqtt_topic=payload.mqtt_topic.strip() if payload.mqtt_topic else default_topic(agency_id, client_id),
        device_key_hash=hash_device_key(device_key),
        status=DeviceStatus.OFFLINE,
    )
    db.add(device)
    try:
        db.commit()
        db.refresh(device)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Ce mqtt_client_id est deja utilise") from exc
    return DeviceRegistrationResponse.model_validate(
        {**DeviceResponse.model_validate(device).model_dump(), "device_key": device_key}
    )


@router.post(
    "/{device_id}/rotate-key",
    response_model=DeviceRegistrationResponse,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def rotate_device_key(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceRegistrationResponse:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    device_key = generate_device_key()
    device.device_key_hash = hash_device_key(device_key)
    # The old key stops working at once - the device is offline until the
    # new one is entered - so who did it must be traceable.
    db.add(
        AuditLog(
            user_id=current_user.id,
            agency_id=device.agency_id,
            action="device_key_rotated",
            entity_type="device",
            entity_id=device.id,
            details={"mqtt_client_id": device.mqtt_client_id},
        )
    )
    db.commit()
    db.refresh(device)
    return DeviceRegistrationResponse.model_validate(
        {**DeviceResponse.model_validate(device).model_dump(), "device_key": device_key}
    )


@router.get("/{device_id}", response_model=DeviceResponse, dependencies=DEVICE_ROLES)
def get_device(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceResponse:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    return device


@router.put("/{device_id}", response_model=DeviceResponse, dependencies=DEVICE_ROLES)
def update_device(
    device_id: str,
    payload: DeviceUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceResponse:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if isinstance(value, str):
            value = value.strip()
            if field == "device_type":
                value = value.upper()
        setattr(device, field, value)

    try:
        db.commit()
        db.refresh(device)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Ce mqtt_client_id est deja utilise") from exc
    return device


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=DEVICE_ROLES)
def delete_device(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    db.delete(device)
    db.commit()
