import json
import logging

import paho.mqtt.client as mqtt

from app.core.config import settings
from app.database.connection import SessionLocal
from app.schemas.attendance import MqttAttendanceMessage
from app.services.attendance_service import (
    attendance_to_dict,
    record_rfid_event,
)
from app.websocket.manager import attendance_manager


logger = logging.getLogger(__name__)


class AttendanceMqttConsumer:
    topic = "agency/+/device/+/attendance"

    def __init__(self) -> None:
        self.client: mqtt.Client | None = None
        self.started = False

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
        logger.info("MQTT attendance consumer started")

    def stop(self) -> None:
        if self.client is not None:
            self.client.loop_stop()
            self.client.disconnect()
        self.started = False

    def on_connect(self, client: mqtt.Client, userdata, flags, reason_code, properties=None) -> None:
        if reason_code == 0:
            client.subscribe(self.topic)
            logger.info("Subscribed to MQTT topic %s", self.topic)
        else:
            logger.warning("MQTT connection refused: %s", reason_code)

    def on_message(self, client: mqtt.Client, userdata, message: mqtt.MQTTMessage) -> None:
        try:
            payload = MqttAttendanceMessage.model_validate_json(message.payload.decode("utf-8"))
            topic_parts = message.topic.split("/")
            agency_id = topic_parts[1]
            device_id = topic_parts[3]
            with SessionLocal() as db:
                attendance, event_name = record_rfid_event(
                    db,
                    payload.employee_rfid,
                    payload.timestamp,
                    agency_id,
                )
                event = attendance_to_dict(attendance)
                event.update({"type": "attendance_updated", "device_id": device_id, "event": event_name})
                attendance_manager.broadcast_from_thread(event)
        except Exception:
            logger.exception("Unable to process MQTT attendance message")


attendance_consumer = AttendanceMqttConsumer()
