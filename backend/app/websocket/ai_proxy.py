"""Authenticated, agency-scoped WebSocket proxies for the AI service streams.

The browser connects to the backend only. The backend validates the access
token against the live database (never the token's own claims alone - see
_resolve_socket_scope), filters every relayed frame down to the caller's own
agency, and relays the AI frames to the browser. This keeps the AI service
private (it has no authentication of its own) and stops a non-admin from
seeing another agency's cameras, zones or workstations over these streams -
the AI process itself is global and has no notion of "agency" in what it
sends.
"""

import asyncio
import json
import logging
import threading
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode

import websockets
from fastapi import APIRouter, WebSocket
from sqlalchemy import func, select

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.core.config import settings
from app.core.security import decode_token
from app.database.connection import SessionLocal
from app.models.entities import Agency, Camera, RoleName, User
from app.websocket.alert_state import alert_state_manager


logger = logging.getLogger(__name__)

router = APIRouter(tags=["AI WebSocket"])

ALERT_ROLES = frozenset(
    {
        RoleName.ADMIN.value,
        RoleName.MANAGER.value,
        RoleName.SECURITY.value,
    }
)
OCCUPANCY_ROLES = frozenset(
    {
        RoleName.ADMIN.value,
        RoleName.MANAGER.value,
    }
)
PEOPLE_ROLES = ALERT_ROLES
WORKSTATION_ROLES = OCCUPANCY_ROLES

_CONNECTION_LOCK = threading.Lock()
_ACTIVE_CONNECTIONS = 0
_ACTIVE_CONNECTIONS_BY_USER: dict[str, int] = {}


@dataclass(frozen=True)
class SocketScope:
    """What one authenticated socket may see. `None` on a field means "every
    agency" (admin only) - every filter below treats None the same as "no
    restriction", so an admin never pays the filtering cost."""

    user_id: str
    cameras: set[str] | None
    zones: set[str] | None
    workstations: set[str] | None


def _upstream_base_url() -> str:
    """Convert the configured AI HTTP URL to its WebSocket equivalent."""
    base = settings.ai_service_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    return base


def _upstream_url(websocket: WebSocket, path: str) -> str:
    """Build an AI URL while never forwarding the frontend JWT."""
    raw_query = websocket.scope.get("query_string", b"")
    if isinstance(raw_query, bytes):
        raw_query = raw_query.decode("utf-8")
    query = urlencode(
        [
            (key, value)
            for key, value in parse_qsl(raw_query, keep_blank_values=True)
            if key != "token"
        ]
    )
    suffix = f"?{query}" if query else ""
    return f"{_upstream_base_url()}{path}{suffix}"


async def _close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except Exception:
        # The peer may already have closed the connection.
        pass


def _zone_agency_map(db) -> dict[str, str | None]:
    """AI-service zone name -> our agency_id, resolved exactly the way
    zones.py's own _agency_of_zone does: a pixel zone reads its own camera,
    a world zone falls back to converted_from's camera. None means nothing
    here can prove an agency (an orphaned or camera-less zone)."""
    response = forward("GET", "/zoning/zones")
    raise_for_ai_status(response)
    zone_agency: dict[str, str | None] = {}
    for name, zone in response.json().items():
        camera_name = zone.get("camera") or (zone.get("converted_from") or {}).get("camera")
        agency_id = None
        if camera_name is not None:
            camera = db.scalar(select(Camera).where(Camera.name == camera_name))
            agency_id = camera.agency_id if camera else None
        zone_agency[name] = agency_id
    return zone_agency


def _workstation_agency_map(db, zone_agency: dict[str, str | None]) -> dict[str, str | None]:
    """Workstation name -> agency_id, via the zone it watches - same
    resolution app/api/workstations.py's own _agency_of_zone uses."""
    response = forward("GET", "/employee_activity/workstations")
    raise_for_ai_status(response)
    return {
        workstation["name"]: zone_agency.get(workstation["zone"])
        for workstation in response.json()
    }


def _resolve_socket_scope(
    websocket: WebSocket, allowed_roles: frozenset[str], stream_kind: str
) -> SocketScope | None:
    """Validate the JWT against the live database user and build the scope
    this socket is allowed to see.

    The database role is authoritative, not the token's own `role` claim - a
    token minted before a demotion or deactivation must not keep streaming
    access just because it hasn't expired yet.
    """
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = decode_token(token)
    except Exception:
        return None

    user_id = payload.get("sub")
    token_role = payload.get("role")
    if not user_id or not token_role:
        return None

    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if user is None or not user.is_active or user.role is None:
            return None

        role = user.role.name.value
        if role != token_role or role not in allowed_roles:
            return None

        if user.role.name == RoleName.ADMIN:
            return SocketScope(user_id=user.id, cameras=None, zones=None, workstations=None)

        if user.agency_id is None:
            return None

        if stream_kind == "people":
            # The global track list carries floor coordinates with no camera
            # or agency attribution at all (contracts/ai-service.md WS
            # /people/tracks/stream) - only the per-camera `boxes` field can
            # be scoped. Safe for a non-admin only while a single agency
            # exists; refuse outright once a second one is added rather than
            # silently leak world positions across agencies.
            active_agencies = (
                db.scalar(select(func.count(Agency.id)).where(Agency.is_active.is_(True))) or 0
            )
            if active_agencies > 1:
                logger.error(
                    "AI people stream refused for user %s: cannot be scoped across %s agencies",
                    user.id,
                    active_agencies,
                )
                return None

        cameras: set[str] | None = None
        zones: set[str] | None = None
        workstations: set[str] | None = None

        if stream_kind in {"alerts", "people"}:
            cameras = set(
                db.scalars(select(Camera.name).where(Camera.agency_id == user.agency_id)).all()
            )
        elif stream_kind == "occupancy":
            zone_agency = _zone_agency_map(db)
            zones = {name for name, agency_id in zone_agency.items() if agency_id == user.agency_id}
        elif stream_kind == "workstations":
            zone_agency = _zone_agency_map(db)
            workstation_agency = _workstation_agency_map(db, zone_agency)
            workstations = {
                name
                for name, agency_id in workstation_agency.items()
                if agency_id == user.agency_id
            }

        return SocketScope(user_id=user.id, cameras=cameras, zones=zones, workstations=workstations)
    finally:
        db.close()


def _reserve_connection(user_id: str) -> bool:
    """Reserve a global and per-user socket slot, or refuse if either cap is
    already hit - an unbounded number of concurrent proxy connections was a
    real resource-exhaustion gap with no limit at all before this."""
    global _ACTIVE_CONNECTIONS
    with _CONNECTION_LOCK:
        per_user = _ACTIVE_CONNECTIONS_BY_USER.get(user_id, 0)
        if _ACTIVE_CONNECTIONS >= settings.ai_ws_max_connections:
            return False
        if per_user >= settings.ai_ws_max_connections_per_user:
            return False
        _ACTIVE_CONNECTIONS += 1
        _ACTIVE_CONNECTIONS_BY_USER[user_id] = per_user + 1
        return True


def _release_connection(user_id: str) -> None:
    global _ACTIVE_CONNECTIONS
    with _CONNECTION_LOCK:
        _ACTIVE_CONNECTIONS = max(0, _ACTIVE_CONNECTIONS - 1)
        current = _ACTIVE_CONNECTIONS_BY_USER.get(user_id, 0)
        if current <= 1:
            _ACTIVE_CONNECTIONS_BY_USER.pop(user_id, None)
        else:
            _ACTIVE_CONNECTIONS_BY_USER[user_id] = current - 1


def _filter_camera_frame(raw_message: str, camera_scope: set[str] | None) -> str | None:
    """Alert frames (contracts/ai-service.md WS /{f}/alerts/stream) are keyed
    by camera name - drop anything outside the caller's own cameras."""
    if camera_scope is None:
        return raw_message
    try:
        frame = json.loads(raw_message)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(frame, dict):
        return None

    if frame.get("type") == "snapshot" and isinstance(frame.get("cameras"), dict):
        frame["cameras"] = {
            name: detections for name, detections in frame["cameras"].items() if name in camera_scope
        }
    elif frame.get("type") == "update" and frame.get("camera") not in camera_scope:
        return None
    return json.dumps(frame)


def _filter_occupancy_frame(raw_message: str, zone_scope: set[str] | None) -> str | None:
    """Occupancy frames (WS /zoning/occupancy/stream) are keyed by zone
    name."""
    if zone_scope is None:
        return raw_message
    try:
        frame = json.loads(raw_message)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(frame, dict):
        return None

    if frame.get("type") == "snapshot" and isinstance(frame.get("zones"), dict):
        frame["zones"] = {name: value for name, value in frame["zones"].items() if name in zone_scope}
    elif frame.get("type") == "update" and frame.get("zone") not in zone_scope:
        return None
    return json.dumps(frame)


def _filter_people_frame(raw_message: str, camera_scope: set[str] | None) -> str | None:
    """Trims the per-camera `boxes` field of WS /people/tracks/stream to the
    caller's own cameras. The bare `tracks` list has no camera attribution
    at all, so it is left as-is - _resolve_socket_scope already refuses this
    stream for a non-admin the moment a second agency exists, which is the
    only thing that makes leaving `tracks` unfiltered safe here."""
    if camera_scope is None:
        return raw_message
    try:
        frame = json.loads(raw_message)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(frame, dict):
        return None

    if isinstance(frame.get("boxes"), dict):
        frame["boxes"] = {name: boxes for name, boxes in frame["boxes"].items() if name in camera_scope}
    return json.dumps(frame)


def _filter_workstation_frame(raw_message: str, workstation_scope: set[str] | None) -> str | None:
    """Employee-activity frames (WS /employee_activity/status/stream) are
    keyed by workstation name; an `update` row has the same shape as one GET
    row (contracts/ai-service.md)."""
    if workstation_scope is None:
        return raw_message
    try:
        frame = json.loads(raw_message)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(frame, dict):
        return None

    if frame.get("type") == "snapshot" and isinstance(frame.get("workstations"), list):
        frame["workstations"] = [
            workstation
            for workstation in frame["workstations"]
            if isinstance(workstation, dict) and workstation.get("name") in workstation_scope
        ]
    elif frame.get("type") == "update" and frame.get("name") not in workstation_scope:
        return None
    return json.dumps(frame)


def _filter_frame(raw_message: str, scope: SocketScope, stream_kind: str) -> str | None:
    if stream_kind == "alerts":
        return _filter_camera_frame(raw_message, scope.cameras)
    if stream_kind == "occupancy":
        return _filter_occupancy_frame(raw_message, scope.zones)
    if stream_kind == "people":
        return _filter_people_frame(raw_message, scope.cameras)
    if stream_kind == "workstations":
        return _filter_workstation_frame(raw_message, scope.workstations)
    return raw_message


async def _proxy(
    websocket: WebSocket,
    upstream_path: str,
    allowed_roles: frozenset[str],
    *,
    stream_kind: str,
    alert_state_feature: str | None = None,
) -> None:
    """Relay one agency-scoped AI stream until either side disconnects."""
    await websocket.accept()
    try:
        scope = _resolve_socket_scope(websocket, allowed_roles, stream_kind)
    except Exception:
        logger.exception("Unable to resolve AI WebSocket authorization scope")
        await _close(websocket, 1013)
        return
    if scope is None:
        await _close(websocket, 1008)
        return

    if not _reserve_connection(scope.user_id):
        logger.warning("AI WebSocket connection limit reached for user %s", scope.user_id)
        await _close(websocket, 1013)
        return

    upstream_url = _upstream_url(websocket, upstream_path)
    upstream_finished = False
    # Alert rows the backend has committed are pushed down the same socket, so
    # the screen sees an alert open and resolve without refetching.
    state_queue = (
        alert_state_manager.subscribe(alert_state_feature, scope)
        if alert_state_feature is not None
        else None
    )
    send_lock = asyncio.Lock()

    try:
        async with websockets.connect(
            upstream_url,
            ping_interval=20,
            ping_timeout=20,
        ) as upstream:

            async def relay_upstream() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        try:
                            message = message.decode("utf-8")
                        except UnicodeDecodeError:
                            continue
                    filtered = _filter_frame(message, scope, stream_kind)
                    if filtered is not None:
                        async with send_lock:
                            await websocket.send_text(filtered)

            async def relay_alert_state() -> None:
                if state_queue is None:
                    return
                while True:
                    payload = await state_queue.get()
                    async with send_lock:
                        await websocket.send_json(payload)

            async def drain_client() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        return

            relay_task = asyncio.create_task(relay_upstream())
            client_task = asyncio.create_task(drain_client())
            state_task = asyncio.create_task(relay_alert_state()) if state_queue is not None else None
            tasks = {relay_task, client_task}
            if state_task is not None:
                tasks.add(state_task)
            done, pending = await asyncio.wait(
                tasks,
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            for task in done:
                try:
                    task.result()
                except Exception as exc:
                    logger.debug("AI WebSocket proxy stopped: %s", exc)
            upstream_finished = relay_task in done or (state_task is not None and state_task in done)
    except websockets.exceptions.ConnectionClosed:
        upstream_finished = True
    except Exception:
        logger.exception("AI service WebSocket unavailable: %s", upstream_url)
        await _close(websocket, 1013)
        return
    finally:
        if state_queue is not None:
            alert_state_manager.unsubscribe(state_queue)
        _release_connection(scope.user_id)

    if upstream_finished:
        await _close(websocket, 1000)


@router.websocket("/ws/alerts/weapon")
async def weapon_alerts_websocket(websocket: WebSocket) -> None:
    await _proxy(
        websocket,
        "/weapon/alerts/stream",
        ALERT_ROLES,
        stream_kind="alerts",
        alert_state_feature="weapon",
    )


@router.websocket("/ws/alerts/fire")
async def fire_alerts_websocket(websocket: WebSocket) -> None:
    await _proxy(
        websocket,
        "/fire/alerts/stream",
        ALERT_ROLES,
        stream_kind="alerts",
        alert_state_feature="fire",
    )


@router.websocket("/ws/alerts/emotion")
async def emotion_alerts_websocket(websocket: WebSocket) -> None:
    await _proxy(
        websocket,
        "/emotion/alerts/stream",
        ALERT_ROLES,
        stream_kind="alerts",
        alert_state_feature="emotion",
    )


@router.websocket("/ws/alerts/wanted")
async def wanted_alerts_websocket(websocket: WebSocket) -> None:
    await _proxy(
        websocket,
        "/wanted/alerts/stream",
        ALERT_ROLES,
        stream_kind="alerts",
        alert_state_feature="wanted",
    )


@router.websocket("/ws/occupancy")
async def occupancy_websocket(websocket: WebSocket) -> None:
    await _proxy(websocket, "/zoning/occupancy/stream", OCCUPANCY_ROLES, stream_kind="occupancy")


@router.websocket("/ws/workstations")
async def workstations_websocket(websocket: WebSocket) -> None:
    # Same roles as /api/workstations (app/api/workstations.py) and the
    # /staffing screen itself - ADMIN and MANAGER, no SECURITY.
    await _proxy(
        websocket, "/employee_activity/status/stream", WORKSTATION_ROLES, stream_kind="workstations"
    )


@router.websocket("/ws/people/tracks")
async def people_tracks_websocket(websocket: WebSocket) -> None:
    # Same roles as /tracking (auth/access.ts) - ADMIN, MANAGER and
    # SECURITY, the live-map bucket, hence ALERT_ROLES rather than
    # OCCUPANCY_ROLES above.
    await _proxy(websocket, "/people/tracks/stream", PEOPLE_ROLES, stream_kind="people")
