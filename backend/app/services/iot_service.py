from datetime import datetime
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entities import (
    Alert,
    AlertSeverity,
    AlertStatus,
    Device,
    DeviceStatus,
    SensorReading,
    SensorThreshold,
)
from app.schemas.sensor import SensorPayload
from app.services.door_control_service import send_door_command
from app.services.notification_service import notify_critical_alerts


PublishCommand = Callable[[str, dict], None]

RAW_GAS_UNITS = {"raw", "adc", "counts", "count"}


def normalize_gas_co(value: float, unit: str | None) -> tuple[float, str, bool]:
    """Return (value, unit, comparable) for a MQ2 gas reading.

    Hardware can send calibrated ppm directly or a raw ADC value. Raw values
    are only converted when explicitly enabled and calibrated in settings.
    Until then they are stored as raw and excluded from ppm thresholding to
    prevent false alerts.
    """
    normalized_unit = (unit or "ppm").strip().lower()
    if normalized_unit == "ppm":
        return value, "ppm", True
    if normalized_unit not in RAW_GAS_UNITS:
        return value, unit or normalized_unit, False
    if not settings.mq2_raw_to_ppm_enabled:
        return value, "raw", False
    ppm = max(
        0.0,
        (value - settings.mq2_raw_baseline) * settings.mq2_raw_ppm_scale
        + settings.mq2_raw_ppm_offset,
    )
    return ppm, "ppm", True


def command_topic(agency_id: str, device_id: str, command: str) -> str:
    return f"agency/{agency_id}/device/{device_id}/{command}"


def severity_for(value: float, threshold: SensorThreshold) -> AlertSeverity | None:
    if threshold.critical_max is not None and value >= threshold.critical_max:
        return AlertSeverity.CRITICAL
    if threshold.warning_max is not None and value >= threshold.warning_max:
        return AlertSeverity.HIGH
    return None


def process_sensor_payload(
    db: Session,
    agency_id: str,
    device_id: str,
    payload: SensorPayload,
) -> list[tuple[str, dict]]:
    device = db.scalar(
        select(Device).where(
            Device.agency_id == agency_id,
            Device.mqtt_client_id == device_id,
        )
    )
    if device is None:
        raise ValueError("Unregistered MQTT device")

    thresholds = {
        threshold.sensor_type: threshold
        for threshold in db.scalars(
            select(SensorThreshold).where(
                SensorThreshold.device_id == device.id,
                SensorThreshold.is_active.is_(True),
            )
        ).all()
    }
    commands: list[tuple[str, dict]] = []
    notify_for: list[str] = []
    recorded_at = payload.timestamp

    device.status = DeviceStatus.ONLINE
    device.last_seen_at = recorded_at

    for item in payload.readings:
        sensor_type = item.sensor_type.strip().lower()
        threshold = thresholds.get(sensor_type)
        unit = item.unit or (threshold.unit if threshold else None)
        value = item.value
        threshold_comparable = True
        if sensor_type == "gas_co":
            value, unit, threshold_comparable = normalize_gas_co(value, unit)
        db.add(
            SensorReading(
                device_id=device.id,
                sensor_type=sensor_type,
                value=value,
                unit=unit,
                recorded_at=recorded_at,
            )
        )

        if threshold is None or not threshold_comparable:
            continue

        alert_type = sensor_type
        active_alert = db.scalar(
            select(Alert).where(
                Alert.device_id == device.id,
                Alert.alert_type == alert_type,
                Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]),
            )
        )
        severity = severity_for(value, threshold)
        value_text = f"{value:g} {unit or ''}".strip()

        if severity is not None:
            changed = active_alert is None or active_alert.severity != severity
            if changed and severity == AlertSeverity.CRITICAL:
                notify_for.append(alert_type)
            if active_alert is None:
                active_alert = Alert(
                    agency_id=agency_id,
                    device_id=device.id,
                    alert_type=alert_type,
                    title=f"Alerte {sensor_type}",
                    message=f"Valeur depassee: {value_text}",
                    severity=severity,
                    status=AlertStatus.OPEN,
                )
                db.add(active_alert)
            else:
                active_alert.severity = severity
                active_alert.message = f"Valeur depassee: {value_text}"
            if changed:
                commands.append(
                    (
                        command_topic(agency_id, device_id, "alert"),
                        {
                            "alert_type": alert_type,
                            "active": True,
                            "severity": severity.value,
                        },
                    )
                )
        elif active_alert is not None:
            active_alert.status = AlertStatus.RESOLVED
            active_alert.resolved_at = recorded_at
            commands.append(
                (
                    command_topic(agency_id, device_id, "alert"),
                    {
                        "alert_type": alert_type,
                        "active": False,
                        "severity": "LOW",
                    },
                )
            )

        # The climate actuator follows the configured temperature warning limit.
        # Publishing the current state on every reading keeps the actuator safe
        # after a backend or broker restart.
        if sensor_type == "temperature" and threshold.warning_max is not None:
            commands.append(
                (
                    command_topic(agency_id, device_id, "climate"),
                    {"active": item.value >= threshold.warning_max},
                )
            )

    db.commit()
    if notify_for:
        critical_ids = db.scalars(
            select(Alert.id).where(
                Alert.device_id == device.id,
                Alert.alert_type.in_(notify_for),
                Alert.status == AlertStatus.OPEN,
                Alert.severity == AlertSeverity.CRITICAL,
            )
        ).all()
        notify_critical_alerts(list(critical_ids))
        if "gas_co" in notify_for:
            # A CO/gas hazard is dangerous to breathe whether or not it is a
            # fire, so it unlocks on its own, same as a camera fire detection.
            send_door_command(
                agency_id,
                "unlock",
                reason="gas_co reading crossed the critical threshold",
                details={"device": device.mqtt_client_id, "alert_type": "gas_co"},
            )
    return commands
