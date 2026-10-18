"""In-process delivery of committed business-alert state events."""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import timezone
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.websocket.ai_proxy import SocketScope

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AlertStateSubscription:
    feature: str
    scope: SocketScope
    queue: asyncio.Queue[dict[str, Any]]
    loop: asyncio.AbstractEventLoop


class AlertStateConnectionManager:
    """Routes committed alert state events to authorized AI alert sockets."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscriptions: dict[int, AlertStateSubscription] = {}

    def subscribe(
        self,
        feature: str,
        scope: SocketScope,
    ) -> asyncio.Queue[dict[str, Any]]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        subscription = AlertStateSubscription(feature, scope, queue, loop)
        with self._lock:
            self._subscriptions[id(queue)] = subscription
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscriptions.pop(id(queue), None)

    def broadcast_from_thread(self, payload: dict[str, Any]) -> None:
        """Publish from an AI consumer thread without blocking its DB loop."""
        with self._lock:
            subscriptions = list(self._subscriptions.values())

        for subscription in subscriptions:
            if not self._is_visible(subscription, payload):
                continue
            if subscription.loop.is_closed():
                self.unsubscribe(subscription.queue)
                continue
            subscription.loop.call_soon_threadsafe(
                self._enqueue,
                subscription.queue,
                payload,
            )

    @staticmethod
    def _is_visible(
        subscription: AlertStateSubscription,
        payload: dict[str, Any],
    ) -> bool:
        if payload.get("alert_type") != subscription.feature:
            return False

        cameras = subscription.scope.cameras
        if cameras is None:  # admin: every branch
            return True
        return payload.get("camera_name") in cameras

    @staticmethod
    def _enqueue(
        queue: asyncio.Queue[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            logger.warning("Alert state queue pleine; ancien evenement supprime")
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            logger.warning("Impossible de publier l etat d alerte au frontend")


def alert_state_payload(alert: Any, camera_name: str, event: str) -> dict[str, Any]:
    """The frame sent to the alert sockets once an alert row is committed.
    `event` is created, updated or resolved."""

    def stamp(value):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    return {
        "type": "alert_state",
        "event": event,
        "id": alert.id,
        "agency_id": alert.agency_id,
        "camera_id": alert.camera_id,
        "camera_name": camera_name,
        "alert_type": alert.alert_type,
        "severity": alert.severity.value,
        "status": alert.status.value,
        "created_at": stamp(alert.created_at),
        "resolved_at": stamp(alert.resolved_at),
    }


alert_state_manager = AlertStateConnectionManager()
