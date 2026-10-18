from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.devices import ensure_agency_scope, get_device_or_404
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import AuditLog, RoleName, User
from app.mqtt.manual_control import manual_control_service
from app.schemas.control import ManualControlRequest, ManualControlResult
from app.services.device_commands import actions_for, load_commands


router = APIRouter(prefix="/controls", tags=["Manual controls"])

# ADMIN/MANAGER/SECURITY - a security operator manually overriding a door
# or lock is exactly the kind of real-time operational action SECURITY
# already has elsewhere (cameras.py's CAMERA_ROLES includes them for the
# same reason). Agency-scoped like every device route.
CONTROL_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]


@router.post(
    "/devices/{device_id}/command",
    response_model=ManualControlResult,
    dependencies=CONTROL_ROLES,
)
def send_command(
    device_id: str,
    payload: ManualControlRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ManualControlResult:
    """Blocks up to manual_control_ack_timeout_seconds (default 10s) - the
    frontend shows a spinner for exactly this call, then renders whichever
    of confirmed/failed/unknown comes back. See
    app/mqtt/manual_control.py's own header for why this blocks instead of
    polling."""
    device = get_device_or_404(device_id, db)
    ensure_agency_scope(device.agency_id, current_user)
    # Only actions contracts/device-commands.json lists for this device type:
    # anything else is refused here, never sent to a device.
    action = payload.action.strip().lower()
    if action not in actions_for(device.device_type):
        allowed = ", ".join(actions_for(device.device_type)) or "aucune"
        raise HTTPException(
            status_code=422,
            detail=f"Commande non prise en charge par cet appareil (possibles: {allowed})",
        )

    result = manual_control_service.send_command(
        agency_id=device.agency_id,
        device_id=device.mqtt_client_id,
        action=action,
        target=payload.target,
    )

    db.add(
        AuditLog(
            user_id=current_user.id,
            agency_id=device.agency_id,
            action="manual_control_command",
            entity_type="device",
            entity_id=device.id,
            details={"command": payload.model_dump(), "result": result},
        )
    )
    db.commit()

    return ManualControlResult(**result)


@router.get("/commands", dependencies=CONTROL_ROLES)
def list_commands() -> dict[str, list[dict[str, str]]]:
    """Device type -> the commands the Manual controls screen offers, with
    their button labels (contracts/device-commands.json)."""
    return load_commands()
