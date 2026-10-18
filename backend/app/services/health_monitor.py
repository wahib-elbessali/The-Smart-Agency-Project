"""Watches the two things whose silent failure blinds the whole system.

A dead AI service means
no weapon/fire/wanted detection at all, and a dead MQTT broker means no gas/CO
readings and no RFID attendance - both look like "nothing is happening", which
is exactly what a safe branch looks like. So each gets its own CRITICAL
meta-alert, raised only after a grace period so a restart or a blip pages
nobody, and resolved automatically on recovery. The notification pipeline then
treats it like any other CRITICAL alert.

Deliberately NOT here: database-down. That is an operational problem (restart
policy, backups, monitoring one Postgres), and it would take the recipient
lookup the notification pipeline needs down with it.

Alert.agency_id is mandatory and both failures are site-wide, so one alert is
opened per active agency.
"""

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import Agency, Alert, AlertSeverity, AlertStatus
from app.services.day_close import close_finished_days
from app.services.access_log import prune_access_failures
from app.services.device_uptime import sample_devices
from app.services.notification_service import notify_critical_alerts


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Component:
    name: str
    alert_type: str
    title: str
    consequence: str


AI_SERVICE = Component(
    "ai_service",
    "ai_service_down",
    "Service IA indisponible",
    "Detection d'armes, de feu et de personnes recherchees hors service.",
)
MQTT_BROKER = Component(
    "mqtt_broker",
    "mqtt_down",
    "Broker MQTT indisponible",
    "Capteurs (gaz/CO, temperature) et pointage RFID hors service.",
)


def probe_ai_service() -> bool:
    try:
        response = httpx.get(settings.ai_service_url.rstrip("/") + "/", timeout=3.0)
        return response.status_code < 500
    except Exception:
        return False


def probe_mqtt_broker() -> bool:
    # Imported here: the MQTT consumer pulls in iot_service, which pulls in the
    # notification service this module also uses.
    from app.mqtt.sensor_consumer import sensor_consumer

    client = sensor_consumer.client
    return client is not None and client.is_connected()


class HealthMonitor:
    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._down_since: dict[str, float] = {}
        self._alerted: set[str] = set()
        self._settled: set[str] = set()
        self._last_device_sample: float | None = None

    def start(self) -> None:
        if not settings.health_monitor_enabled or (
            self._thread is not None and self._thread.is_alive()
        ):
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="health-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.check_once()
            except Exception:
                logger.exception("health check failed")
            self._stop_event.wait(settings.health_check_interval_seconds)

    def check_once(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        probes: list[tuple[Component, Callable[[], bool]]] = [(MQTT_BROKER, probe_mqtt_broker)]
        if settings.ai_alerts_enabled:
            probes.append((AI_SERVICE, probe_ai_service))
        for component, probe in probes:
            try:
                healthy = probe()
            except Exception:
                healthy = False
            self.record(component, healthy, now)
        self._maybe_sample_devices(now)
        self._maybe_close_days(now)

    def _maybe_close_days(self, now: float) -> None:
        """Unserved tickets of a closed branch become NO_SHOW (day_close.py),
        checked about once a minute on this same thread."""
        last = getattr(self, "_last_day_close", None)
        if last is None or now - last >= 60:
            self._last_day_close = now
            close_finished_days()

    def _maybe_sample_devices(self, now: float) -> None:
        """The uptime history rides this thread but on its own, slower clock."""
        last = self._last_device_sample
        if last is None or now - last >= settings.device_sample_interval_seconds:
            self._last_device_sample = now
            sample_devices()
            prune_access_failures()

    def record(self, component: Component, healthy: bool, now: float) -> None:
        """The state machine, separate from the probes so it can be tested with
        an injected clock."""
        name = component.name
        if healthy:
            self._down_since.pop(name, None)
            # The first healthy look after a backend restart also clears an
            # alert left open by a previous run that never saw the recovery.
            if name in self._alerted or name not in self._settled:
                if self._resolve(component):
                    self._alerted.discard(name)
                    self._settled.add(name)
            return

        self._settled.add(name)
        since = self._down_since.setdefault(name, now)
        if name not in self._alerted and now - since >= settings.health_down_grace_seconds:
            if self._open(component, int(now - since)):
                self._alerted.add(name)

    def _open(self, component: Component, down_seconds: int) -> bool:
        db = SessionLocal()
        try:
            agency_ids = db.scalars(select(Agency.id).where(Agency.is_active.is_(True))).all()
            new_ids = []
            for agency_id in agency_ids:
                already = db.scalar(
                    select(Alert.id).where(
                        Alert.agency_id == agency_id,
                        Alert.alert_type == component.alert_type,
                        Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
                    )
                )
                if already is not None:
                    continue
                alert = Alert(
                    agency_id=agency_id,
                    alert_type=component.alert_type,
                    title=component.title,
                    message=f"Ne repond plus depuis {down_seconds}s. {component.consequence}",
                    severity=AlertSeverity.CRITICAL,
                    status=AlertStatus.OPEN,
                )
                db.add(alert)
                db.flush()
                new_ids.append(alert.id)
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("could not open %s alert", component.alert_type)
            return False
        finally:
            db.close()
        logger.warning("%s is down: opened %d alert(s)", component.name, len(new_ids))
        notify_critical_alerts(new_ids)
        return True

    def _resolve(self, component: Component) -> bool:
        db = SessionLocal()
        try:
            open_alerts = db.scalars(
                select(Alert).where(
                    Alert.alert_type == component.alert_type,
                    Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
                )
            ).all()
            resolved_at = datetime.now(timezone.utc)
            for alert in open_alerts:
                alert.status = AlertStatus.RESOLVED
                alert.resolved_at = resolved_at
            db.commit()
            if open_alerts:
                logger.warning(
                    "%s recovered: resolved %d alert(s)", component.name, len(open_alerts)
                )
            return True
        except Exception:
            db.rollback()
            logger.exception("could not resolve %s alert", component.alert_type)
            return False
        finally:
            db.close()


health_monitor = HealthMonitor()
