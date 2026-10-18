"""Emotion samples for customer satisfaction. Same connect/sync-sources/
consume-WS shape as the other AI consumers, but NOT an alert - there's no
OPEN/RESOLVED incident here, every classified face is just logged as a row
(EmotionSample) for later aggregation (see app/api/insights.py).

Deliberately not built on GenericAlertConsumer, which is specifically
shaped around the alert lifecycle (open/resolve, one active alert per
camera). Reusing the connection scaffolding by duplicating it once more
matches the same "small, verified duplication over a forced-fit
abstraction" call already made for fire/wanted.
"""

import asyncio
import json
import logging
import threading
import time
from typing import Any
from urllib.parse import quote

import httpx
import websockets
from sqlalchemy import select

from app.ai_alerts.camera_features import sources_for
from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import Camera, DeviceStatus, EmotionSample


logger = logging.getLogger(__name__)


class EmotionConsumer:
    def __init__(self) -> None:
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
        self._thread = threading.Thread(target=self._run, name="emotion-consumer", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def request_sync(self) -> None:
        self._sync_event.set()

    def _run(self) -> None:
        try:
            asyncio.run(self._consume_forever())
        except Exception:
            logger.exception("emotion consumer stopped")

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
                await self._consume_stream()
            except Exception as exc:
                logger.warning("emotion AI stream unavailable: %s", exc)
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
            return sources_for(db, "emotion")
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
        return f"{base}/emotion/alerts/stream"

    def _sync_sources(self, sources: dict[str, str], force: bool = False) -> None:
        if not force and sources == self._last_sources:
            return
        with httpx.Client(timeout=5.0) as client:
            response = client.post(
                f"{self._ai_http_base_url}/emotion/sources", json={"sources": sources}
            )
            response.raise_for_status()
            for removed_name in set(self._last_sources) - set(sources):
                client.delete(
                    f"{self._ai_http_base_url}/emotion/sources/{quote(removed_name, safe='')}"
                )
        self._last_sources = dict(sources)
        logger.info("emotion: sources synced with AI service: %s", sorted(sources))

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
                    logger.warning("emotion: ignored non-JSON message")
                    continue
                if not isinstance(message, dict):
                    continue
                self.process_message(message)

    def process_message(self, message: dict[str, Any]) -> None:
        """Public for deterministic tests, same convention as the alert
        consumers. Every classified face is logged, including a repeat
        classification of the SAME still-visible person on the next frame -
        there's no track id in this stream to dedupe by, and averaging
        naturally weights someone who lingers longer, which is arguably
        correct for a satisfaction signal anyway."""
        message_type = message.get("type")
        if message_type == "snapshot":
            cameras = message.get("cameras")
            if isinstance(cameras, dict):
                for camera_name, detections in cameras.items():
                    self._persist_samples(camera_name, detections)
            return
        if message_type == "update":
            camera_name = message.get("camera")
            if isinstance(camera_name, str):
                self._persist_samples(camera_name, message.get("detections", []))

    def _persist_samples(self, camera_name: Any, raw_detections: Any) -> None:
        if not isinstance(raw_detections, list) or not raw_detections:
            return
        db = SessionLocal()
        try:
            camera = db.scalar(select(Camera).where(Camera.name == camera_name))
            if camera is None:
                logger.warning("emotion: no backend camera matches AI name %r", camera_name)
                return
            camera.status = DeviceStatus.ONLINE
            for raw in raw_detections:
                if not isinstance(raw, dict):
                    continue
                try:
                    confidence = float(raw["confidence"])
                except (KeyError, TypeError, ValueError):
                    continue
                db.add(
                    EmotionSample(
                        agency_id=camera.agency_id,
                        camera_id=camera.id,
                        emotion=str(raw.get("class", "unknown")),
                        confidence=confidence,
                    )
                )
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("emotion: could not persist samples for %r", camera_name)
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
            logger.exception("emotion: could not update camera status")
        finally:
            db.close()


emotion_consumer = EmotionConsumer()
