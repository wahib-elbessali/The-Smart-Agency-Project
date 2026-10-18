"""Weapon and watchlist alerts are incidents: one per branch per subject,
closed by a person, not by the camera clearing (2026-10-18 day test)."""
import pytest

import app.ai_alerts.base_consumer as base_mod
import app.ai_alerts.consumer as weapon_mod
from app.ai_alerts.wanted_consumer import wanted_alert_consumer
from app.ai_alerts.consumer import weapon_alert_consumer
from app.models.entities import Alert, AlertStatus, Camera


@pytest.fixture()
def cams(db, agency, monkeypatch):
    for mod in (base_mod, weapon_mod):
        monkeypatch.setattr(mod, "SessionLocal", lambda: db)
        monkeypatch.setattr(mod, "notify_critical_alerts", lambda ids: None)
        monkeypatch.setattr(mod.alert_state_manager, "broadcast_from_thread", lambda e: None)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(weapon_alert_consumer, "lockdown_observe", lambda *a: None)
    db.add_all([Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x/1"),
                Camera(agency_id=agency.id, name="cam2", stream_url="rtsp://x/2")])
    db.commit()


def active(db, alert_type):
    return db.query(Alert).filter(Alert.alert_type == alert_type,
                                  Alert.status != AlertStatus.RESOLVED).all()


def test_two_cameras_one_weapon_incident_that_outlives_the_view(db, cams):
    pistol = [{"class": "pistol", "confidence": 0.9}]
    weapon_alert_consumer.process_message({"type": "update", "camera": "cam1", "detections": pistol})
    weapon_alert_consumer.process_message({"type": "update", "camera": "cam2", "detections": pistol})
    assert len(active(db, "weapon")) == 1

    weapon_alert_consumer.process_message({"type": "update", "camera": "cam1", "detections": []})
    weapon_alert_consumer.process_message({"type": "update", "camera": "cam2", "detections": []})
    [alert] = active(db, "weapon")
    assert "plus visible depuis" in alert.message


def test_wanted_incidents_are_per_name_and_sticky(db, cams):
    def seen(camera, *names):
        wanted_alert_consumer.process_message({"type": "update", "camera": camera, "detections": [
            {"class": n, "confidence": 0.6} for n in names]})

    seen("cam1", "SUSPECT-001")
    seen("cam2", "SUSPECT-001")
    # the same name on a second camera joined the first incident
    assert [a.title for a in active(db, "wanted")] == ["Personne recherchee: SUSPECT-001"]
    seen("cam2", "OTHER-7")  # a different wanted person is a different incident
    titles = sorted(a.title for a in active(db, "wanted"))
    assert titles == ["Personne recherchee: OTHER-7", "Personne recherchee: SUSPECT-001"]
    seen("cam1")
    seen("cam2")
    assert len(active(db, "wanted")) == 2  # out of view, still open


def test_fire_still_resolves_per_camera(db, cams):
    from app.ai_alerts.fire_consumer import fire_alert_consumer
    import app.ai_alerts.fire_consumer as fire_mod

    monkey_door = []
    base_mod.send_door_command, original = (lambda *a, **k: monkey_door.append(a)), base_mod.send_door_command
    try:
        fire_alert_consumer.process_message({"type": "update", "camera": "cam1",
                                             "detections": [{"class": "smoke", "confidence": 0.8}]})
        fire_alert_consumer.process_message({"type": "update", "camera": "cam1", "detections": []})
    finally:
        base_mod.send_door_command = original
    assert active(db, "fire") == []
