"""A badge at the REST gate reader must reach the live Employee presence feed,
the same as one arriving over MQTT (found in the 2026-10-18 day test: the
screen only changed on reload)."""
from fastapi.testclient import TestClient

from app.api import internal
from app.core.device_security import hash_device_key
from app.database.connection import get_db
from app.main import app
from app.models.entities import Device, DeviceStatus, Employee


def test_check_rfid_broadcasts_the_attendance_event(db, agency, monkeypatch):
    db.add(Device(agency_id=agency.id, name="Gate", device_type="RFID_READER", mqtt_client_id="gate-1",
                  mqtt_topic="t", device_key_hash=hash_device_key("k"), status=DeviceStatus.ONLINE))
    db.add(Employee(agency_id=agency.id, first_name="Sara", last_name="B", rfid_uid="CARD-1"))
    db.commit()
    sent = []
    monkeypatch.setattr(internal.attendance_manager, "broadcast_from_thread", sent.append)
    monkeypatch.setattr(internal, "link_employee_tracking", lambda *a: None)
    app.dependency_overrides[get_db] = lambda: db
    try:
        r = TestClient(app).post(
            "/internal/attendance/check-rfid",
            json={"agency_id": agency.id, "device_id": "gate-1", "employee_rfid": "CARD-1"},
            headers={"X-Device-Key": "k"},
        )
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200 and r.json()["event"] == "check_in"
    assert len(sent) == 1
    assert sent[0]["type"] == "attendance_updated"
    assert sent[0]["agency_id"] == agency.id
    assert sent[0]["event"] == "check_in"
