"""Manual hardware overrides: dashboard click -> MQTT command -> real
lock/motor/relay -> MQTT ack -> back to the SAME HTTP response the
dashboard is waiting on.

WHY THIS BLOCKS THE REQUEST INSTEAD OF POLLING

Decided with the user (2026-09-23), specifically to fit the UX already
decided for ManualControls.tsx: spinner while pending, "unknown" - not a
guessed success or failure - if no ack arrives within
settings.manual_control_ack_timeout_seconds, no automatic retry. A single
blocking HTTP call that resolves to confirmed/failed/unknown is the
simplest way to deliver exactly that: the frontend awaits one request and
renders whichever of the three states comes back, no separate polling
loop or websocket needed for this one screen.

Every OTHER command topic in this app (sensor_consumer.py's
publish_command) is deliberately fire-and-forget - this is the one place
a human is actively watching a spinner for the round trip, which is the
whole reason a correlation id and an ack topic exist here at all.
"""

import json
import logging
import threading
import uuid

import paho.mqtt.client as mqtt

from app.core.config import settings
from app.mqtt.topics import CONTROL_ACK_SUBSCRIPTION, CONTROL_COMMAND_TOPIC


logger = logging.getLogger(__name__)


class ManualControlService:
    def __init__(self) -> None:
        self.client: mqtt.Client | None = None
        self.started = False
        self._lock = threading.Lock()
        self._pending: dict[str, threading.Event] = {}
        self._results: dict[str, dict] = {}

    def start(self) -> None:
        if self.started:
            return
        self.started = True
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if settings.mqtt_username:
            self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.connect_async(settings.mqtt_host, settings.mqtt_port, 60)
        self.client.loop_start()
        logger.info("Manual control MQTT service started")

    def stop(self) -> None:
        if self.client is not None:
            self.client.loop_stop()
            self.client.disconnect()
        self.started = False

    def on_connect(self, client: mqtt.Client, userdata, flags, reason_code, properties=None) -> None:
        if reason_code == 0:
            client.subscribe(CONTROL_ACK_SUBSCRIPTION, qos=1)
            logger.info("Subscribed to %s", CONTROL_ACK_SUBSCRIPTION)
        else:
            logger.warning("MQTT connection refused: %s", reason_code)

    def on_message(self, client: mqtt.Client, userdata, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            logger.warning("Invalid control-ack payload on %s", message.topic)
            return
        correlation_id = payload.get("correlation_id")
        if not isinstance(correlation_id, str):
            return
        with self._lock:
            event = self._pending.get(correlation_id)
            if event is None:
                # Arrived after this backend gave up waiting (a slow device,
                # or a restart mid-flight) - nothing to wake, and nobody is
                # reading _results for an id that isn't pending anymore.
                return
            self._results[correlation_id] = payload
            event.set()

    def send_command(
        self,
        agency_id: str,
        device_id: str,
        action: str,
        target: str | None = None,
    ) -> dict:
        """Blocks up to manual_control_ack_timeout_seconds. Returns
        {status: "confirmed"|"failed"|"unknown", detail}. Never raises for
        a timeout or a device-reported failure - both are real, expected
        outcomes the caller (the HTTP route) turns into a normal response,
        not an error."""
        if self.client is None or not self.started:
            return {"status": "unknown", "detail": "Service MQTT non demarre"}

        correlation_id = uuid.uuid4().hex
        event = threading.Event()
        with self._lock:
            self._pending[correlation_id] = event

        topic = CONTROL_COMMAND_TOPIC.format(agency_id=agency_id, device_id=device_id)
        payload = {"correlation_id": correlation_id, "action": action, "target": target}
        try:
            result = self.client.publish(topic, json.dumps(payload), qos=1, retain=False)
            published = result.rc == mqtt.MQTT_ERR_SUCCESS
        except Exception:
            logger.exception("Manual control publish failed for %s", topic)
            published = False

        if not published:
            with self._lock:
                self._pending.pop(correlation_id, None)
            return {"status": "unknown", "detail": "Commande non envoyee (MQTT indisponible)"}

        got_ack = event.wait(timeout=settings.manual_control_ack_timeout_seconds)
        with self._lock:
            self._pending.pop(correlation_id, None)
            ack = self._results.pop(correlation_id, None)

        if not got_ack or ack is None:
            return {
                "status": "unknown",
                "detail": "Aucune confirmation recue du materiel dans le delai imparti",
            }
        if ack.get("status") == "ok":
            return {"status": "confirmed", "detail": ack.get("detail")}
        if ack.get("status") == "unknown_action":
            # contracts/device-commands.json lists it, the firmware does not
            # implement it: the two have drifted apart.
            return {
                "status": "failed",
                "detail": "Le firmware de cet appareil ne connait pas cette commande "
                "(contrat et firmware differents)",
            }
        return {"status": "failed", "detail": ack.get("detail", "Le materiel a signale une erreur")}


manual_control_service = ManualControlService()
