"""Backend-side consumer of the AI service's multi-camera person-tracking
stream, plus the kiosk-zone correlations that read it.

Scenario-planning backlog (docs/scenario-planning-backlog.md). Phase B: the
moment a visitor takes a ticket at the kiosk, link whichever anonymous
tracked person is standing in the kiosk's zone to that ticket. Losing the
link entirely if nobody takes a ticket is fine, by design. Phase C adds a
second, independent correlation off the SAME kiosk zone: if a wanted-type
alert fires on the kiosk's own camera close to when the ticket was issued,
tag that alert with the ticket too - both pulled from one zone fetch. Phase
F reuses the same zone-fetch/point-in-polygon machinery a third way, at
RFID door readers instead of the kiosk - a badge scan links whichever
tracked person is in that device's own configured zone to the Employee,
deliberately re-linking (overwriting) on every scan rather than once.

Unlike the four alert consumers in app/ai_alerts/, PeopleTrackConsumer
writes nothing to the database and has no open/resolve lifecycle - it just
keeps the most recent tracked positions in memory, so a ticket-creation
request can ask "who's in this zone right now" synchronously, without a
live round trip to the AI service on the hot path. It also doesn't manage
source registration the way the alert consumers do: /people/sources is
already a separate, deliberately manual opt-in the Tracking screen owns
(app/api/people.py), so this consumer only ever connects and reconnects -
nothing to sync.
"""

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import websockets
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import camera_id_by_name, forward, raise_for_ai_status
from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import Agency, Alert, AlertStatus, Device, Employee, Ticket


logger = logging.getLogger(__name__)


class PeopleTrackConsumer:
    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._tracks: dict[str, dict[str, Any]] = {}
        # Tracking's own phase (idle/bootstrapping/running/error, from the
        # stream's snapshot/state frames) and when positions last arrived:
        # positions are only trusted while both say "live".
        self._phase: str | None = None
        self._last_tracks_at = 0.0

    def start(self) -> None:
        if not settings.ai_alerts_enabled or (
            self._thread is not None and self._thread.is_alive()
        ):
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="people-track-consumer", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def _run(self) -> None:
        try:
            asyncio.run(self._consume_forever())
        except Exception:
            logger.exception("people-track consumer stopped")

    async def _consume_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._consume_stream()
            except Exception as exc:
                logger.warning("people-track AI stream unavailable: %s", exc)
                self._forget("stream lost")
                await self._wait(settings.ai_reconnect_delay_seconds)

    async def _wait(self, seconds: float) -> None:
        def wait_for_signal() -> None:
            deadline = time.monotonic() + seconds
            while not self._stop_event.is_set() and time.monotonic() < deadline:
                time.sleep(min(deadline - time.monotonic(), 0.25))

        await asyncio.to_thread(wait_for_signal)

    @property
    def _ai_websocket_url(self) -> str:
        base = settings.ai_service_url.rstrip("/")
        if base.startswith("https://"):
            base = "wss://" + base[len("https://") :]
        elif base.startswith("http://"):
            base = "ws://" + base[len("http://") :]
        return f"{base}/people/tracks/stream"

    async def _consume_stream(self) -> None:
        async with websockets.connect(
            self._ai_websocket_url, ping_interval=20, ping_timeout=20
        ) as socket:
            while not self._stop_event.is_set():
                try:
                    raw_message = await asyncio.wait_for(socket.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if raw_message is None:
                    return
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                try:
                    message = json.loads(raw_message)
                except (TypeError, json.JSONDecodeError):
                    logger.warning("people-track: ignored non-JSON message")
                    continue
                if not isinstance(message, dict):
                    continue
                self.process_message(message)

    def process_message(self, message: dict[str, Any]) -> None:
        """Public for deterministic tests, same convention as the alert
        consumers. Tracks are the FULL confirmed-track snapshot every cycle,
        never diffed (contracts/ai-service.md) - so this replaces the whole
        dict each time, carrying first_seen over for ids already known."""
        kind = message.get("type")
        if kind == "state" or (kind == "snapshot" and message.get("state")):
            self._phase = message.get("phase") if kind == "state" else message.get("state")
            if self._phase != "running":
                self._forget(self._phase)
                return
        if kind not in ("snapshot", "tracks"):
            return
        raw_tracks = message.get("tracks")
        if not isinstance(raw_tracks, list):
            return

        now = datetime.now(timezone.utc)
        rebuilt: dict[str, dict[str, Any]] = {}
        with self._lock:
            previous = self._tracks
            for raw in raw_tracks:
                if not isinstance(raw, dict) or "id" not in raw:
                    continue
                track_id = str(raw["id"])
                try:
                    x, y = float(raw["x"]), float(raw["y"])
                except (KeyError, TypeError, ValueError):
                    continue
                first_seen = previous.get(track_id, {}).get("first_seen", now)
                rebuilt[track_id] = {"x": x, "y": y, "first_seen": first_seen}
            self._tracks = rebuilt
            self._last_tracks_at = time.monotonic()
            if kind == "tracks":
                self._phase = "running"

    def _forget(self, why: str | None) -> None:
        """No live positions any more (stream lost, tracking stopped): drop
        the last ones rather than keep people where they were last seen."""
        with self._lock:
            self._tracks = {}
            if why == "stream lost":
                self._phase = None

    def is_live(self) -> bool:
        """Tracking is running and positions are arriving."""
        return (
            self._phase == "running"
            and time.monotonic() - self._last_tracks_at <= settings.people_tracks_stale_seconds
        )

    def tracks_snapshot(self) -> dict[str, dict[str, Any]]:
        """The live positions - empty when they stopped arriving."""
        with self._lock:
            if time.monotonic() - self._last_tracks_at > settings.people_tracks_stale_seconds:
                return {}
            return dict(self._tracks)


people_track_tracker = PeopleTrackConsumer()


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    """Standard ray-casting point-in-polygon test. `polygon` is a list of
    [x, y] vertices in the same unit as x and y."""
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    x1, y1 = polygon[-1]
    for x2, y2 in polygon:
        if (y1 > y) != (y2 > y):
            x_intersect = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_intersect:
                inside = not inside
        x1, y1 = x2, y2
    return inside


def _fetch_zone(zone_name: str) -> dict[str, Any] | None:
    """The raw AI-service zone dict for a named zone - not kiosk-specific,
    despite the module's original Phase-B-only naming; reused for the
    kiosk zone (Phases B/C/D) and any device's badge zone (Phase F) alike.
    None on absolutely anything that isn't a clean fetch - the zone not
    existing, the AI service being unreachable, a malformed response. One
    fetch serves every correlation that needs the same zone, never one
    round trip per correlation."""
    try:
        response = forward("GET", "/zoning/zones")
        raise_for_ai_status(response)
        zone = response.json().get(zone_name)
        return zone if isinstance(zone, dict) else None
    except Exception:
        logger.warning("people-track: could not fetch zone %r", zone_name)
        return None


def _track_in_zone(zone: dict[str, Any]) -> tuple[str, datetime] | None:
    """Which live track (if any) is standing inside this already-fetched
    world-mode zone. None if it isn't world mode (no polygon_m yet) or
    nobody's currently in it - never raises."""
    polygon = zone.get("polygon_m")
    if not isinstance(polygon, list) or len(polygon) < 3:
        return None
    # GET /zoning/zones exports polygon_m in metres; track positions are floor
    # centimetres (the AI service's own zone counting works in cm).
    try:
        polygon = [[float(x) * 100.0, float(y) * 100.0] for x, y in polygon]
    except (TypeError, ValueError):
        return None
    for track_id, track in people_track_tracker.tracks_snapshot().items():
        if point_in_polygon(track["x"], track["y"], polygon):
            return track_id, track["first_seen"]
    return None


def resolve_kiosk_track(kiosk_zone_name: str) -> tuple[str, datetime] | None:
    """Convenience wrapper combining the two steps above - kept as the
    public single-call entry point (and what earlier tests call directly)."""
    zone = _fetch_zone(kiosk_zone_name)
    return _track_in_zone(zone) if zone is not None else None


def resolve_kiosk_camera_name(zone: dict[str, Any]) -> str | None:
    """The AI-service camera name a zone was drawn from - a pixel zone's own
    camera, or a world zone's converted_from.camera. Same extraction
    zones.py's _agency_of_zone does, as a plain expression rather than a
    third full copy of that function (this only needs the name, not the
    agency)."""
    name = zone.get("camera") or (zone.get("converted_from") or {}).get("camera")
    return name if isinstance(name, str) else None


_WANTED_CORRELATION_WINDOW = timedelta(seconds=30)


def _link_wanted_alert(db: Session, ticket: Ticket, zone: dict[str, Any]) -> None:
    """If a wanted-type alert fired on the kiosk's own camera shortly before
    this ticket was issued, tag it with the ticket - never steals a link
    from an alert an earlier ticket already claimed, never raises."""
    # The kiosk's face camera, when set, is where a watchlist match at the
    # kiosk comes from; the zone's camera is the fallback.
    camera_ids = set()
    face_camera_id = ticket.visitor.agency.kiosk_face_camera_id if ticket.visitor else None
    if face_camera_id:
        camera_ids.add(face_camera_id)
    camera_name = resolve_kiosk_camera_name(zone)
    zone_camera_id = camera_id_by_name(db, camera_name) if camera_name else None
    if zone_camera_id:
        camera_ids.add(zone_camera_id)
    if not camera_ids:
        return

    alert = db.scalar(
        select(Alert)
        .where(
            Alert.camera_id.in_(camera_ids),
            Alert.alert_type == "wanted",
            Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
            Alert.ticket_id.is_(None),
            Alert.created_at >= ticket.created_at - _WANTED_CORRELATION_WINDOW,
        )
        .order_by(Alert.created_at.desc())
    )
    if alert is not None:
        alert.ticket_id = ticket.id


def link_ticket_tracking(ticket_id: str, agency_id: str) -> None:
    """Runs as a FastAPI background task, after the kiosk already has its
    ticket number - never on the request path that prints a ticket. Opens
    its own session since the request's is already closed by the time a
    background task runs. Does both kiosk-zone correlations (tracking link,
    wanted-alert tag) off one zone fetch."""
    db = SessionLocal()
    try:
        agency = db.get(Agency, agency_id)
        if agency is None or not agency.kiosk_zone_name:
            return
        zone = _fetch_zone(agency.kiosk_zone_name)
        if zone is None:
            return

        ticket = db.get(Ticket, ticket_id)
        if ticket is None:
            return

        match = _track_in_zone(zone)
        if match is not None:
            ticket.tracking_id, ticket.tracking_first_seen_at = match

        _link_wanted_alert(db, ticket, zone)

        db.commit()
    except Exception:
        db.rollback()
        logger.exception("people-track: could not link ticket %s", ticket_id)
    finally:
        db.close()


def link_employee_tracking(employee_id: str, device_id: str) -> None:
    """Runs as a FastAPI background task after a successful badge scan -
    never on the hot path of a door actuator or an attendance clock.
    `device_id` here is the Device PRIMARY KEY (not the mqtt_client_id used
    elsewhere in internal.py's hardware-facing endpoints) - the caller
    already resolved the Device row to authenticate the scan.

    Deliberately OVERWRITES employee.tracking_id on every call, unlike
    every other link in this backlog - this is what makes it self-heal
    across a shift's worth of badge scans at different zone doors, the
    tracker's lack of long-term re-identification notwithstanding.
    """
    db = SessionLocal()
    try:
        device = db.get(Device, device_id)
        if device is None or not device.badge_zone_name:
            return
        zone = _fetch_zone(device.badge_zone_name)
        if zone is None:
            return
        match = _track_in_zone(zone)
        if match is None:
            return
        track_id, _first_seen = match

        employee = db.get(Employee, employee_id)
        if employee is None:
            return
        employee.tracking_id = track_id
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("people-track: could not link employee %s", employee_id)
    finally:
        db.close()
