"""Generic version of WeaponAlertConsumer's shape, for the alert types that
don't need weapon's extra business-threshold layer (classifier.py) on top
of the AI service's own confidence - fire (nothing to tune) and wanted
(already has its own adjustable threshold on the AI service side, see
POST/PUT /watchlist/threshold, proxied separately rather than duplicated
here).

WeaponAlertConsumer itself is left untouched rather than rewritten to
extend this - it's real, deployed, working code, and duplicating its shape
here once (well-tested pattern, see fire_consumer.py/wanted_consumer.py)
is a smaller risk than refactoring it out from under itself.
"""

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote

import httpx
import websockets
from sqlalchemy import select

from app.ai_alerts.incidents import STICKY_ALERT_TYPES, find_incident, incident_title, mark_out_of_view
from app.ai_alerts.camera_features import close_alerts_off_feature, sources_for
from app.ai_alerts.thresholds import restore_thresholds
from app.core.config import settings
from app.database.connection import SessionLocal
from app.websocket.alert_state import alert_state_manager, alert_state_payload
from app.models.entities import Alert, AlertSeverity, AlertStatus, Camera, DeviceStatus
from app.services.door_control_service import send_door_command
from app.services.notification_service import notify_critical_alerts


logger = logging.getLogger(__name__)

# detections -> the alert message body, e.g. "arme (0.91), couteau (0.77)"
MessageBuilder = Callable[[list[dict[str, Any]]], str]


class GenericAlertConsumer:
    def __init__(
        self,
        *,
        alert_type: str,
        stream_path: str,
        sources_path: str,
        thread_name: str,
        alert_title: str,
        build_message: MessageBuilder,
        severity: AlertSeverity = AlertSeverity.CRITICAL,
    ) -> None:
        self.alert_type = alert_type
        self.stream_path = stream_path
        self.sources_path = sources_path
        self.thread_name = thread_name
        self.alert_title = alert_title
        self.build_message = build_message
        self.severity = severity

        self._stop_event = threading.Event()
        self._sync_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_sources: dict[str, str] = {}

    def start(self) -> None:
        if not settings.ai_alerts_enabled or (
            self._thread is not None and self._thread.is_alive()
        ):
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name=self.thread_name, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def request_sync(self) -> None:
        """Wake the next consumer cycle after a camera is created or updated."""
        self._sync_event.set()

    def _run(self) -> None:
        try:
            asyncio.run(self._consume_forever())
        except Exception:
            logger.exception("%s alert consumer stopped", self.alert_type)

    async def _consume_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                sources = await asyncio.to_thread(self._load_sources)
            except Exception as exc:
                # A database hiccup must not stop detection for good: retry.
                logger.warning("%s: could not read cameras: %s", type(self).__name__, exc)
                await self._wait(settings.ai_reconnect_delay_seconds)
                continue
            if not sources:
                await self._wait(settings.ai_reconnect_delay_seconds)
                continue

            try:
                await asyncio.to_thread(self._sync_sources, sources, True)
                # The AI service keeps its threshold only in memory.
                await asyncio.to_thread(restore_thresholds, [self.alert_type])
                await self._consume_stream()
            except Exception as exc:
                logger.warning("%s AI stream unavailable: %s", self.alert_type, exc)
                await asyncio.to_thread(self._mark_offline, sources)
                await self._wait(settings.ai_reconnect_delay_seconds)

    async def _wait(self, seconds: float) -> None:
        def wait_for_signal() -> None:
            deadline = time.monotonic() + seconds
            while not self._stop_event.is_set() and time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                if self._sync_event.wait(timeout=min(remaining, 0.25)):
                    self._sync_event.clear()
                    return

        await asyncio.to_thread(wait_for_signal)

    def _load_sources(self) -> dict[str, str]:
        # Only the cameras set to run this detection (Camera.ai_features).
        db = SessionLocal()
        try:
            return sources_for(db, self.alert_type)
        finally:
            db.close()

    @property
    def _ai_http_base_url(self) -> str:
        return settings.ai_service_url.rstrip("/")

    @property
    def _ai_websocket_url(self) -> str:
        base = self._ai_http_base_url
        if base.startswith("https://"):
            base = "wss://" + base[len("https://") :]
        elif base.startswith("http://"):
            base = "ws://" + base[len("http://") :]
        return f"{base}{self.stream_path}"

    def _sync_sources(self, sources: dict[str, str], force: bool = False) -> None:
        if not force and sources == self._last_sources:
            return

        close_alerts_off_feature(self.alert_type, set(sources))

        with httpx.Client(timeout=5.0) as client:
            response = client.post(
                f"{self._ai_http_base_url}{self.sources_path}",
                json={"sources": sources},
            )
            response.raise_for_status()

            for removed_name in set(self._last_sources) - set(sources):
                client.delete(
                    f"{self._ai_http_base_url}{self.sources_path}/{quote(removed_name, safe='')}"
                )

        self._last_sources = dict(sources)
        logger.info("%s: sources synced with AI service: %s", self.alert_type, sorted(sources))

    async def _consume_stream(self) -> None:
        async with websockets.connect(
            self._ai_websocket_url, ping_interval=20, ping_timeout=20
        ) as socket:
            last_sync = time.monotonic()
            while not self._stop_event.is_set():
                try:
                    raw_message = await asyncio.wait_for(socket.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    now = time.monotonic()
                    if (
                        self._sync_event.is_set()
                        or now - last_sync >= settings.ai_source_sync_interval_seconds
                    ):
                        self._sync_event.clear()
                        sources = await asyncio.to_thread(self._load_sources)
                        await asyncio.to_thread(self._sync_sources, sources)
                        last_sync = now
                        if not sources:
                            return
                    continue

                if raw_message is None:
                    return
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                try:
                    message = json.loads(raw_message)
                except (TypeError, json.JSONDecodeError):
                    logger.warning("%s: ignored non-JSON message", self.alert_type)
                    continue
                if not isinstance(message, dict):
                    continue
                self.process_message(message)

    def process_message(self, message: dict[str, Any]) -> None:
        """Public for deterministic tests, same as WeaponAlertConsumer's."""
        message_type = message.get("type")
        if message_type == "snapshot":
            cameras = message.get("cameras")
            if isinstance(cameras, dict):
                for camera_name, detections in cameras.items():
                    self._persist_camera_update(camera_name, detections)
            return
        if message_type == "update":
            camera_name = message.get("camera")
            if isinstance(camera_name, str):
                self._persist_camera_update(camera_name, message.get("detections", []))

    def _normalise_detections(self, raw_detections: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_detections, list):
            return []
        detections: list[dict[str, Any]] = []
        for raw in raw_detections:
            if not isinstance(raw, dict):
                continue
            try:
                confidence = float(raw["confidence"])
            except (KeyError, TypeError, ValueError):
                continue
            detection = {"class": str(raw.get("class", self.alert_type)), "confidence": confidence}
            if "bbox" in raw:
                detection["bbox"] = raw["bbox"]
            detections.append(detection)
        return detections

    def _persist_camera_update(self, camera_name: Any, raw_detections: Any) -> None:
        detections = self._normalise_detections(raw_detections)
        newly_opened: list[str] = []
        state_events: list[dict] = []
        db = SessionLocal()
        try:
            camera = db.scalar(select(Camera).where(Camera.name == camera_name))
            if camera is None:
                logger.warning(
                    "%s: no backend camera matches AI name %r", self.alert_type, camera_name
                )
                return

            camera.status = DeviceStatus.ONLINE
            open_alerts = db.scalars(
                select(Alert).where(
                    Alert.camera_id == camera.id,
                    Alert.alert_type == self.alert_type,
                    Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
                )
            ).all()

            sticky = self.alert_type in STICKY_ALERT_TYPES
            if detections:
                alert_message = self.build_message(detections)
                title = incident_title(self.alert_type, self.alert_title, detections)
                incident = (
                    find_incident(db, camera.agency_id, self.alert_type, title)
                    if sticky and not open_alerts
                    else None
                )
                if open_alerts or incident is not None:
                    # This camera's own alert, or the branch's incident it joins.
                    for alert in open_alerts or [incident]:
                        alert.message = alert_message
                        alert.severity = self.severity
                        state_events.append(alert_state_payload(alert, camera.name, "updated"))
                else:
                    new_alert = Alert(
                        agency_id=camera.agency_id,
                        camera_id=camera.id,
                        alert_type=self.alert_type,
                        title=title,
                        message=alert_message,
                        severity=self.severity,
                        status=AlertStatus.OPEN,
                    )
                    db.add(new_alert)
                    db.flush()
                    newly_opened.append(new_alert.id)
                    state_events.append(alert_state_payload(new_alert, camera.name, "created"))
            elif sticky:
                # Out of view is not over: a person closes these (incidents.py).
                for alert in open_alerts:
                    if mark_out_of_view(alert, camera.name):
                        state_events.append(alert_state_payload(alert, camera.name, "updated"))
            else:
                resolved_at = datetime.now(timezone.utc)
                for alert in open_alerts:
                    alert.status = AlertStatus.RESOLVED
                    alert.resolved_at = resolved_at
                    state_events.append(alert_state_payload(alert, camera.name, "resolved"))

            db.commit()
            for event in state_events:
                alert_state_manager.broadcast_from_thread(event)
            notify_critical_alerts(newly_opened)
            if newly_opened and self.alert_type == "fire":
                # Opposite caution from weapon lockdown: no persistence gate, no
                # toggle - a false unlock is cheap, a false lock can trap people.
                send_door_command(
                    camera.agency_id,
                    "unlock",
                    reason="fire/smoke detected by camera",
                    details={"camera": camera.name, "alert_type": "fire"},
                )
        except Exception:
            db.rollback()
            logger.exception("%s: could not persist alert for %r", self.alert_type, camera_name)
        finally:
            db.close()

    def _mark_offline(self, sources: dict[str, str]) -> None:
        if not sources:
            return
        db = SessionLocal()
        try:
            cameras = db.scalars(select(Camera).where(Camera.name.in_(sources))).all()
            for camera in cameras:
                camera.status = DeviceStatus.OFFLINE
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("%s: could not update camera status", self.alert_type)
        finally:
            db.close()
