from types import SimpleNamespace

from app.api.alerts import router
from app.websocket.alert_state import AlertStateConnectionManager


def test_persisted_alerts_route_is_exposed() -> None:
    paths = {route.path for route in router.routes}
    assert "/agencies/{agency_id}/alerts" in paths


def test_alert_state_visibility_is_scoped_by_feature_and_camera() -> None:
    manager = AlertStateConnectionManager()
    subscription = SimpleNamespace(
        feature="weapon",
        scope=SimpleNamespace(
            cameras={"camera-entrance"},
        ),
    )

    visible = {
        "alert_type": "weapon",
        "agency_id": "agency-1",
        "camera_name": "camera-entrance",
    }
    assert manager._is_visible(subscription, visible) is True
    assert manager._is_visible(
        subscription,
        {**visible, "camera_name": "camera-counter"},
    ) is False
    assert manager._is_visible(
        subscription,
        {**visible, "alert_type": "fire"},
    ) is False


# ------------------------------------------------------------- the route itself
from fastapi.testclient import TestClient

from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Agency, Alert, AlertSeverity, AlertStatus, Camera, RoleName

from .conftest import make_user


def _client(db, user):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def _alert(db, agency, camera, alert_type="weapon", status=AlertStatus.OPEN):
    row = Alert(agency_id=agency.id, camera_id=camera.id if camera else None, alert_type=alert_type,
                title="t", message="m", severity=AlertSeverity.CRITICAL, status=status)
    db.add(row)
    db.commit()
    return row


def test_lists_the_branchs_alerts_newest_first_and_filters_by_type(db, roles, agency):
    cam = Camera(agency_id=agency.id, name="entrance", stream_url="rtsp://x/1")
    db.add(cam)
    db.commit()
    first = _alert(db, agency, cam)
    _alert(db, agency, cam, alert_type="fire")
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    try:
        client = _client(db, manager)
        everything = client.get(f"/api/agencies/{agency.id}/alerts").json()
        assert len(everything) == 2
        weapon = client.get(f"/api/agencies/{agency.id}/alerts", params={"alert_type": "weapon"}).json()
        assert [a["id"] for a in weapon] == [first.id]
        assert weapon[0]["camera_name"] == "entrance"
    finally:
        app.dependency_overrides.clear()


def test_an_alert_whose_camera_was_deleted_still_lists(db, roles, agency):
    _alert(db, agency, None)
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    try:
        row = _client(db, manager).get(f"/api/agencies/{agency.id}/alerts").json()[0]
        assert row["camera_id"] is None and row["camera_name"] is None
    finally:
        app.dependency_overrides.clear()


def test_another_branch_is_refused_and_agents_cannot_read(db, roles, agency):
    other = Agency(name="Branch B")
    db.add(other)
    db.commit()
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    agent = make_user(db, roles, RoleName.AGENT, agency.id, "a@x")
    try:
        assert _client(db, manager).get(f"/api/agencies/{other.id}/alerts").status_code == 403
        assert _client(db, agent).get(f"/api/agencies/{agency.id}/alerts").status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_an_admin_socket_sees_every_camera_and_still_only_its_feature():
    manager = AlertStateConnectionManager()
    admin = SimpleNamespace(feature="weapon", scope=SimpleNamespace(cameras=None))
    assert manager._is_visible(admin, {"alert_type": "weapon", "camera_name": "anywhere"}) is True
    assert manager._is_visible(admin, {"alert_type": "fire", "camera_name": "anywhere"}) is False


def test_the_state_frame_has_the_contract_shape():
    from datetime import datetime
    from app.models.entities import Alert, AlertSeverity, AlertStatus
    from app.websocket.alert_state import alert_state_payload

    alert = Alert(id="a1", agency_id="g1", camera_id="c1", alert_type="weapon", title="t", message="m",
                  severity=AlertSeverity.CRITICAL, status=AlertStatus.OPEN, created_at=datetime(2026, 1, 1, 10, 0))
    frame = alert_state_payload(alert, "entrance", "created")
    assert frame["type"] == "alert_state" and frame["event"] == "created"
    assert frame["created_at"].endswith("+00:00") and frame["resolved_at"] is None
    assert (frame["severity"], frame["status"], frame["camera_name"]) == ("CRITICAL", "OPEN", "entrance")


# ------------------------------------------------- sensor alerts + acknowledge
from app.models.entities import Device, DeviceStatus

from .conftest import make_alert


def test_sensor_alerts_carry_their_device_title_and_message(db, roles, agency):
    device = Device(agency_id=agency.id, name="Capteurs + porte", device_type="ACCESS_SENSORS",
                    mqtt_client_id="s1", mqtt_topic="t", device_key_hash="x", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    alert = make_alert(db, agency.id, "temperature")
    alert.device_id = device.id
    db.commit()
    client = _client(db, make_user(db, roles, RoleName.ADMIN, None, "a@x"))
    try:
        row = client.get(f"/api/agencies/{agency.id}/alerts").json()[0]
    finally:
        app.dependency_overrides.clear()
    assert row["alert_type"] == "temperature"
    assert row["device_name"] == "Capteurs + porte"
    assert row["title"] == "temperature" and row["message"] == "temperature message"


def test_acknowledge_marks_open_alerts_only(db, roles, agency):
    open_alert = make_alert(db, agency.id, "gas_co")
    resolved = make_alert(db, agency.id, "gas_co", status=AlertStatus.RESOLVED)
    client = _client(db, make_user(db, roles, RoleName.SECURITY, agency.id, "s@x"))
    try:
        assert client.post(f"/api/alerts/{open_alert.id}/acknowledge").json()["status"] == "ACKNOWLEDGED"
        assert client.post(f"/api/alerts/{resolved.id}/acknowledge").json()["status"] == "RESOLVED"
        assert client.post("/api/alerts/nope/acknowledge").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_acknowledge_is_scoped_to_the_users_branch(db, roles, agency):
    other = Agency(name="Other")
    db.add(other)
    db.commit()
    alert = make_alert(db, other.id, "temperature")
    client = _client(db, make_user(db, roles, RoleName.MANAGER, agency.id, "m@x"))
    try:
        assert client.post(f"/api/alerts/{alert.id}/acknowledge").status_code == 403
    finally:
        app.dependency_overrides.clear()
