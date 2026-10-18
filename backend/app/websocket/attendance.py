from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.security import decode_token
from app.database.connection import SessionLocal
from app.models.entities import RoleName, User
from app.websocket.manager import ALL_AGENCIES, attendance_manager


router = APIRouter(tags=["Attendance WebSocket"])

# Same roles as the attendance HTTP routes.
ATTENDANCE_STREAM_ROLES = {RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY}


def resolve_attendance_scope(token: str | None) -> str | None:
    """Which agency's events this token may receive: an agency id, ALL_AGENCIES
    for an admin, or None when the connection must be refused.

    The user is looked up in the database rather than trusting the token's own
    claims, so a deactivated or demoted account stops receiving events even
    though its token has not expired."""
    if not token:
        return None
    try:
        payload = decode_token(token)
    except Exception:
        return None
    with SessionLocal() as db:
        user = db.get(User, payload["sub"])
        if user is None or not user.is_active or user.role is None:
            return None
        if user.role.name not in ATTENDANCE_STREAM_ROLES:
            return None
        if user.role.name == RoleName.ADMIN:
            return ALL_AGENCIES
        return user.agency_id  # None for a branchless account: refused


@router.websocket("/ws/attendance")
async def attendance_websocket(websocket: WebSocket, token: str | None = None) -> None:
    scope = resolve_attendance_scope(token)
    if scope is None:
        await websocket.close(code=1008)
        return

    await attendance_manager.connect(websocket, scope)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        attendance_manager.disconnect(websocket)
