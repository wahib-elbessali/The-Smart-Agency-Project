"""Manual controls send only the commands contracts/device-commands.json lists
for the device's type - the one list the backend, the dashboard and the
firmware share."""
import json
import re
from pathlib import Path
from types import SimpleNamespace

import paho.mqtt.client as mqtt
from fastapi.testclient import TestClient

from app.api import controls
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Device, DeviceStatus, RoleName
from app.mqtt.manual_control import ManualControlService
from app.services.device_commands import DEFAULT_PATH, load_commands

from .conftest import make_user

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


def _setup(db, roles, agency, monkeypatch, device_type):
    device = Device(agency_id=agency.id, name="d", device_type=device_type, mqtt_client_id="dev-1",
                    mqtt_topic="t", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    sent = []
    monkeypatch.setattr(controls.manual_control_service, "send_command",
                        lambda **kw: sent.append(kw) or {"status": "confirmed", "detail": "ok"})
    guard = make_user(db, roles, RoleName.SECURITY, agency.id, "g@x")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: guard
    return TestClient(app), device, sent


def test_a_door_takes_its_listed_commands_and_nothing_else(db, roles, agency, monkeypatch):
    client, device, sent = _setup(db, roles, agency, monkeypatch, "ACCESS_SENSORS")
    try:
        ok = client.post(f"/api/controls/devices/{device.id}/command", json={"action": "Unlock"})
        typo = client.post(f"/api/controls/devices/{device.id}/command", json={"action": "unlcok"})
        commands = client.get("/api/controls/commands").json()
    finally:
        app.dependency_overrides.clear()
    assert ok.json()["status"] == "confirmed"
    assert [s["action"] for s in sent] == ["unlock"]  # the typo never reached the device
    assert typo.status_code == 422
    assert {"action": "unlock", "label": "Unlock"} in commands["ACCESS_SENSORS"]


def test_a_device_without_commands_refuses_every_action(db, roles, agency, monkeypatch):
    client, device, sent = _setup(db, roles, agency, monkeypatch, "TICKET_KIOSK")
    try:
        r = client.post(f"/api/controls/devices/{device.id}/command", json={"action": "unlock"})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 422 and "aucune" in r.json()["detail"]
    assert sent == []


def test_the_commands_come_from_the_contract_file():
    assert DEFAULT_PATH == CONTRACTS / "device-commands.json"
    raw = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
    assert set(load_commands()) == {k for k in raw if not k.startswith("_")}


def test_the_hardware_contract_names_every_command():
    """Change device-commands.json without ingestion.md (what the firmware
    author reads) and this fails."""
    text = (CONTRACTS / "ingestion.md").read_text(encoding="utf-8")
    section = text[text.index("## 6b."): text.index("## 7.")]
    for device_type, commands in load_commands().items():
        assert f"`{device_type}`" in section, device_type
        for command in commands:
            assert re.search(rf"`{re.escape(command['action'])}`", section), (device_type, command)


def test_firmware_that_does_not_know_the_command_is_reported_as_drift():
    service = ManualControlService()
    service.started = True

    def publish(topic, payload, **kw):
        cid = json.loads(payload)["correlation_id"]
        service._results[cid] = {"correlation_id": cid, "status": "unknown_action"}
        service._pending[cid].set()
        return SimpleNamespace(rc=mqtt.MQTT_ERR_SUCCESS)
    service.client = SimpleNamespace(publish=publish)
    result = service.send_command(agency_id="a", device_id="d", action="unlock", target=None)
    assert result["status"] == "failed"
    assert "contrat et firmware differents" in result["detail"]


def test_rotating_a_device_key_is_audit_logged(db, roles, agency):
    from app.models.entities import AuditLog
    device = Device(agency_id=agency.id, name="d", device_type="ACCESS_SENSORS", mqtt_client_id="dev-9",
                    mqtt_topic="t", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: manager
    try:
        assert TestClient(app).post(f"/api/devices/{device.id}/rotate-key").status_code == 200
    finally:
        app.dependency_overrides.clear()
    [log] = db.query(AuditLog).filter_by(action="device_key_rotated").all()
    assert log.user_id == manager.id and log.entity_id == device.id


def test_door_faces_stay_off_the_face_screen(db, roles, agency, monkeypatch):
    import httpx
    from app.api import face
    monkeypatch.setattr(face, "forward", lambda *a, **k: httpx.Response(
        200, json=[{"name": "Sara B", "embeddings": [[0]]}, {"name": "emp-123", "embeddings": [[0]]}]))
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: manager
    try:
        client = TestClient(app)
        assert [f["name"] for f in client.get("/api/face/faces").json()] == ["Sara B"]
        assert client.delete("/api/face/faces/emp-123").status_code == 422
    finally:
        app.dependency_overrides.clear()
