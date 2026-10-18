"""Badge + face doors: the door opens only for the badge holder's own face."""
import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import internal
from app.core.device_security import hash_device_key
from app.database.connection import get_db
from app.main import app
from app.models.entities import Camera, Device, DeviceStatus, Employee, Zone
from app.services import door_face
from app.services.door_face import face_key


@pytest.fixture()
def door(db, agency, monkeypatch):
    camera = Camera(agency_id=agency.id, name="door-cam", stream_url="rtsp://x/door")
    db.add(camera)
    db.flush()
    secure = Zone(agency_id=agency.id, name="Coffre", access_mode="rfid_face", door_camera_id=camera.id)
    plain = Zone(agency_id=agency.id, name="Accueil")
    db.add_all([secure, plain])
    db.flush()
    employee = Employee(agency_id=agency.id, first_name="Sara", last_name="B", rfid_uid="CARD-1",
                        authorized_zones=[secure, plain])
    db.add_all([employee, Device(agency_id=agency.id, name="ESP32", device_type="ACCESS_SENSORS",
                                 mqtt_client_id="access-sensors-1", mqtt_topic="t",
                                 device_key_hash=hash_device_key("k"), status=DeviceStatus.ONLINE)])
    db.commit()
    monkeypatch.setattr(internal, "link_employee_tracking", lambda *a: None)
    monkeypatch.setattr(internal, "log_access_failure", lambda *a: None)
    app.dependency_overrides[get_db] = lambda: db
    yield {"secure": secure, "plain": plain, "employee": employee, "agency": agency}
    app.dependency_overrides.clear()


def tap(ctx, zone):
    return TestClient(app).post(
        "/internal/access/door-access",
        json={"agency_id": ctx["agency"].id, "device_id": "access-sensors-1",
              "employee_rfid": "CARD-1", "zone_id": zone.id},
        headers={"X-Device-Key": "k"},
    ).json()


def ai_answers(monkeypatch, status=200, body=None, raises=None):
    calls = []

    def fake(method, path, **kw):
        calls.append((path, kw.get("json")))
        if raises:
            raise raises
        return httpx.Response(status, json=body or {})
    monkeypatch.setattr(door_face, "forward", fake)
    return calls


def test_the_badge_holders_face_opens_it(door, monkeypatch):
    calls = ai_answers(monkeypatch, body={"name": face_key(door["employee"].id), "timed_out": False, "error": None})
    assert tap(door, door["secure"])["authorized"] is True
    assert calls[0][0] == "/face/scan" and calls[0][1]["source"] == "rtsp://x/door"


@pytest.mark.parametrize("body,status,message", [
    ({"name": "emp-someone-else", "timed_out": False, "error": None}, 200, "Le visage ne correspond pas au badge"),
    ({"name": None, "timed_out": False, "error": None}, 200, "Visage non reconnu"),
    ({"name": None, "timed_out": True, "error": None}, 200, "Visage non detecte, regardez la camera"),
    ({"name": None, "timed_out": False, "error": "could not open source"}, 200, "Camera de porte indisponible"),
    ({}, 409, "Verification en cours, reessayez"),
])
def test_anything_else_keeps_it_shut(door, monkeypatch, body, status, message):
    ai_answers(monkeypatch, status=status, body=body)
    answer = tap(door, door["secure"])
    assert answer["authorized"] is False and answer["message"] == message


def test_ai_down_keeps_it_shut(door, monkeypatch):
    ai_answers(monkeypatch, raises=HTTPException(status_code=503, detail="down"))
    assert tap(door, door["secure"])["message"] == "Verification du visage indisponible"


def test_badge_only_rooms_never_scan(door, monkeypatch):
    calls = ai_answers(monkeypatch)
    assert tap(door, door["plain"])["authorized"] is True
    assert calls == []
