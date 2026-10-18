import json
import logging

import paho.mqtt.client as mqtt

from app.core.config import settings
from app.database.connection import SessionLocal
from app.schemas.sensor import SensorPayload
from app.services.iot_service import process_sensor_payload


logger = logging.getLogger(__name__)


class SensorMqttConsumer:
    topic = "agency/+/device/+/sensor"

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
        logger.info("MQTT sensor consumer started")

    def stop(self) -> None:
        if self.client is not None:
            self.client.loop_stop()
            self.client.disconnect()
        self.started = False

    def on_connect(self, client: mqtt.Client, userdata, flags, reason_code, properties=None) -> None:
        if reason_code == 0:
            client.subscribe(self.topic, qos=1)
            logger.info("Subscribed to MQTT topic %s", self.topic)
        else:
            logger.warning("MQTT connection refused: %s", reason_code)

    def publish_command(self, topic: str, payload: dict) -> bool:
        """Publish a backend command without making the HTTP caller fail.

        MQTT delivery is intentionally best-effort here. The ticket is already
        committed in PostgreSQL when this method is called, so a broker outage
        must be logged instead of turning a successful ticket call into a 500.
        """
        if self.client is None:
            logger.warning("MQTT publisher is not started; message not sent to %s", topic)
            return False

        try:
            result = self.client.publish(
                topic,
                json.dumps(payload),
                qos=1,
                retain=False,
            )
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.warning("MQTT publish failed for %s: rc=%s", topic, result.rc)
                return False
            return True
        except Exception:
            logger.exception("MQTT publish failed for %s", topic)
            return False

    def on_message(self, client: mqtt.Client, userdata, message: mqtt.MQTTMessage) -> None:
        try:
            topic_parts = message.topic.split("/")
            if len(topic_parts) != 5 or topic_parts[0] != "agency" or topic_parts[2] != "device":
                logger.warning("Invalid sensor topic: %s", message.topic)
                return
            agency_id = topic_parts[1]
            device_id = topic_parts[3]
            payload = SensorPayload.model_validate_json(message.payload.decode("utf-8"))
            with SessionLocal() as db:
                commands = process_sensor_payload(db, agency_id, device_id, payload)
            for topic, command_payload in commands:
                self.publish_command(topic, command_payload)
        except (ValueError, UnicodeDecodeError) as exc:
            logger.warning("Invalid MQTT sensor message: %s", exc)
        except Exception:
            logger.exception("Unable to process MQTT sensor message")


sensor_consumer = SensorMqttConsumer()
