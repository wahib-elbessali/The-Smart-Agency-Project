import time

import pytest
from sqlalchemy import select

import app.ai_alerts.consumer as consumer_module
from app.models.entities import Agency, AlertStatus, AuditLog
from tests.conftest import make_alert

WINDOW = 0.15


@pytest.fixture()
def gate(factory, monkeypatch, agency):
    sent = []
    monkeypatch.setattr(consumer_module, "LOCKDOWN_CONFIRM_SECONDS", WINDOW)
    monkeypatch.setattr(
        consumer_module, "send_door_command", lambda *a, **k: sent.append((a, k))
    )
    gate = consumer_module.WeaponAlertConsumer()
    gate.sent = sent
    yield gate
    gate.stop()


def wait_past_window():
    time.sleep(WINDOW * 3)


def test_steady_weapon_locks_once_after_window(gate, agency):
    # The AI stream sends ONE update for a weapon that stays in view.
    gate.lockdown_observe(agency.id, "cam1", True)
    assert gate.sent == []
    wait_past_window()
    assert len(gate.sent) == 1
    assert gate.sent[0][0][:2] == (agency.id, "lock")


def test_repeat_detection_does_not_lock_again(gate, agency):
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert len(gate.sent) == 1


def test_flicker_cleared_inside_window_never_locks(gate, agency):
    gate.lockdown_observe(agency.id, "cam1", True)
    gate.lockdown_observe(agency.id, "cam1", False)
    wait_past_window()
    assert gate.sent == []


def test_second_camera_in_same_episode_does_not_relock(gate, agency):
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    gate.lockdown_observe(agency.id, "cam2", True)
    wait_past_window()
    assert len(gate.sent) == 1


def test_new_episode_after_all_clear_locks_again(gate, agency):
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    gate.lockdown_observe(agency.id, "cam1", False)
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert len(gate.sent) == 2


def test_toggle_off_never_locks_but_enabling_mid_incident_locks_next_detection(
    gate, agency, db
):
    agency.weapon_lockdown_enabled = False
    db.commit()
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert gate.sent == []

    agency = db.get(Agency, agency.id)
    agency.weapon_lockdown_enabled = True
    db.commit()
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert len(gate.sent) == 1


@pytest.mark.parametrize("hazard", ["fire", "gas_co"])
def test_open_fire_or_gas_blocks_the_lock_and_is_audited(gate, agency, db, hazard):
    make_alert(db, agency.id, hazard)
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert gate.sent == []
    skipped = db.scalars(select(AuditLog).where(AuditLog.action == "auto_lock_skipped")).all()
    assert len(skipped) == 1
    assert hazard in skipped[0].details["reason"]


def test_resolved_fire_does_not_block(gate, agency, db):
    make_alert(db, agency.id, "fire", status=AlertStatus.RESOLVED)
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert len(gate.sent) == 1


def test_no_auto_relock_when_fire_clears_during_the_same_weapon_episode(gate, agency, db):
    fire = make_alert(db, agency.id, "fire")
    gate.lockdown_observe(agency.id, "cam1", True)
    wait_past_window()
    assert gate.sent == []
    fire.status = AlertStatus.RESOLVED
    db.commit()
    gate.lockdown_observe(agency.id, "cam1", True)  # weapon still there, nothing changed
    wait_past_window()
    assert gate.sent == []


def test_failed_hazard_check_errs_on_the_side_of_not_locking(gate, agency, monkeypatch):
    def broken_session():
        raise RuntimeError("db down")

    monkeypatch.setattr(consumer_module, "SessionLocal", broken_session)
    assert gate._open_hazard(agency.id) == "unknown"


def test_door_commands_reach_the_access_sensors_esp32(db, agency, monkeypatch):
    """The door servo lives on the ACCESS_SENSORS ESP32 (ingestion contract);
    matching only device_type DOOR meant no emergency command reached it."""
    from app.models.entities import Device, DeviceStatus
    from app.services import door_control_service as dcs
    from app.mqtt import sensor_consumer as sc

    db.add_all([
        Device(agency_id=agency.id, name="ESP32", device_type="ACCESS_SENSORS", mqtt_client_id="access-sensors-1",
               mqtt_topic="t1", device_key_hash="x", status=DeviceStatus.ONLINE),
        Device(agency_id=agency.id, name="Door", device_type="door", mqtt_client_id="door-2",
               mqtt_topic="t2", device_key_hash="x", status=DeviceStatus.ONLINE),
        Device(agency_id=agency.id, name="Kiosk", device_type="TICKET_KIOSK", mqtt_client_id="kiosk-1",
               mqtt_topic="t3", device_key_hash="x", status=DeviceStatus.ONLINE),
    ])
    db.commit()
    topics = []
    monkeypatch.setattr(sc.sensor_consumer, "publish_command", lambda topic, payload: topics.append(topic) or True)
    results = dcs.send_door_command(agency.id, "unlock", reason="test")
    assert sorted(r["name"] for r in results) == ["Door", "ESP32"]
    assert any(t.endswith("/access-sensors-1/control") for t in topics)
