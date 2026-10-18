"""Camera and counter routes: what happens to records that point at a camera
or counter, and what the AI service is told. Foreign keys are enforced here
(SQLite ignores them by default) because the real database does."""
import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import cameras as cameras_api
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import (
    Agency,
    Alert,
    AlertSeverity,
    AlertStatus,
    Camera,
    Counter,
    EmotionSample,
    RoleName,
    Ticket,
    TicketStatus,
    Visitor,
)

from .conftest import make_user


class FakeAI:
    def __init__(self):
        self.calls = []
        self.replies = {}  # (method, path) -> (status, body) or an exception

    def __call__(self, method, path, **_):
        self.calls.append((method, path))
        reply = self.replies.get((method, path), (200, {}))
        if isinstance(reply, Exception):
            raise reply
        return httpx.Response(reply[0], json=reply[1])


@pytest.fixture()
def ai(monkeypatch):
    fake = FakeAI()
    monkeypatch.setattr(cameras_api, "forward", fake)
    return fake


@pytest.fixture()
def api(db, roles, agency):
    db.execute(text("PRAGMA foreign_keys=ON"))
    admin = make_user(db, roles, RoleName.ADMIN, None, "admin@x")
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def camera(db, agency):
    row = Camera(agency_id=agency.id, name="entrance", stream_url="rtsp://x/1")
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def counter(db, agency):
    row = Counter(agency_id=agency.id, number=1, name="Guichet 1")
    db.add(row)
    db.commit()
    return row


# ------------------------------------------------------------------ cameras
def test_deleting_a_camera_keeps_what_pointed_at_it(api, ai, db, agency, camera, counter):
    db.add_all([
        EmotionSample(agency_id=agency.id, camera_id=camera.id, emotion="happy", confidence=0.9),
        Alert(agency_id=agency.id, camera_id=camera.id, alert_type="weapon",
              severity=AlertSeverity.CRITICAL, status=AlertStatus.OPEN, title="t", message="m"),
    ])
    counter.emotion_camera_id = camera.id
    db.commit()

    assert api.delete(f"/api/cameras/{camera.id}").status_code == 204

    db.expire_all()
    assert db.query(Camera).count() == 0
    assert db.query(EmotionSample).one().camera_id is None
    assert db.query(Alert).one().camera_id is None
    assert db.get(Counter, counter.id).emotion_camera_id is None


def test_deleting_a_camera_removes_it_from_the_ai_service(api, ai, camera):
    api.delete(f"/api/cameras/{camera.id}")
    assert ("DELETE", "/cameras/entrance") in ai.calls


def test_deleting_works_while_the_ai_service_is_down(api, ai, db, camera):
    ai.replies[("DELETE", "/cameras/entrance")] = HTTPException(503, "down")
    assert api.delete(f"/api/cameras/{camera.id}").status_code == 204
    assert db.query(Camera).count() == 0


def test_renaming_a_calibrated_camera_is_refused(api, ai, camera):
    ai.replies[("GET", "/calibration")] = (200, {"entrance": {"Hinv": []}})
    response = api.put(f"/api/cameras/{camera.id}", json={"name": "lobby"})
    assert response.status_code == 409
    assert "calibration" in response.json()["detail"]
    assert ("DELETE", "/cameras/entrance") not in ai.calls


def test_renaming_a_camera_used_by_a_zone_is_refused(api, ai, camera):
    ai.replies[("GET", "/zoning/zones")] = (200, {"hall": {"mode": "pixel", "camera": "entrance"}})
    assert api.put(f"/api/cameras/{camera.id}", json={"name": "lobby"}).status_code == 409


def test_a_clean_rename_forgets_the_old_name_in_the_ai_service(api, ai, db, camera):
    response = api.put(f"/api/cameras/{camera.id}", json={"name": "lobby"})
    assert response.status_code == 200
    assert response.json()["name"] == "lobby"
    assert ("DELETE", "/cameras/entrance") in ai.calls


def test_changing_only_the_stream_leaves_the_ai_registry_alone(api, ai, camera):
    assert api.put(f"/api/cameras/{camera.id}", json={"stream_url": "rtsp://x/2"}).status_code == 200
    assert not [c for c in ai.calls if c[0] == "DELETE"]


def test_rename_proceeds_when_the_ai_service_cannot_be_asked(api, ai, camera):
    ai.replies[("GET", "/calibration")] = HTTPException(503, "down")
    assert api.put(f"/api/cameras/{camera.id}", json={"name": "lobby"}).status_code == 200


# ----------------------------------------------------------------- counters
def test_counter_cannot_be_linked_to_a_missing_camera(api, counter):
    response = api.put(f"/api/counters/{counter.id}", json={"emotion_camera_id": "nope"})
    assert response.status_code == 404


def test_counter_cannot_use_another_branchs_camera(api, db, counter):
    other = Agency(name="Branch B")
    db.add(other)
    db.commit()
    foreign = Camera(agency_id=other.id, name="other-cam", stream_url="rtsp://x/9")
    db.add(foreign)
    db.commit()
    response = api.put(f"/api/counters/{counter.id}", json={"emotion_camera_id": foreign.id})
    assert response.status_code == 422


def test_counter_links_and_unlinks_its_own_branchs_camera(api, db, counter, camera):
    assert api.put(f"/api/counters/{counter.id}", json={"emotion_camera_id": camera.id}).json()[
        "emotion_camera_id"
    ] == camera.id
    assert api.put(f"/api/counters/{counter.id}", json={"emotion_camera_id": None}).json()[
        "emotion_camera_id"
    ] is None


@pytest.mark.parametrize("field", ["number", "is_open"])
def test_counter_required_fields_cannot_be_cleared(api, counter, field):
    response = api.put(f"/api/counters/{counter.id}", json={field: None})
    assert response.status_code == 422


def test_a_duplicate_number_is_still_a_409(api, db, agency, counter):
    db.add(Counter(agency_id=agency.id, number=2, name="Guichet 2"))
    db.commit()
    assert api.put(f"/api/counters/{counter.id}", json={"number": 2}).status_code == 409


def _ticket(db, agency, counter, status):
    visitor = Visitor(agency_id=agency.id, full_name="V")
    db.add(visitor)
    db.commit()
    ticket = Ticket(visitor_id=visitor.id, counter_id=counter.id, ticket_number="T-1", status=status)
    db.add(ticket)
    db.commit()
    return ticket


@pytest.mark.parametrize("status", [TicketStatus.CALLED, TicketStatus.IN_SERVICE])
def test_a_counter_serving_a_ticket_cannot_be_deleted(api, db, agency, counter, status):
    _ticket(db, agency, counter, status)
    response = api.delete(f"/api/counters/{counter.id}")
    assert response.status_code == 409
    assert db.get(Counter, counter.id) is not None


def test_a_counter_with_only_finished_tickets_can_be_deleted_and_they_are_kept(api, db, agency, counter):
    ticket = _ticket(db, agency, counter, TicketStatus.COMPLETED)
    assert api.delete(f"/api/counters/{counter.id}").status_code == 204
    db.expire_all()
    assert db.get(Ticket, ticket.id).counter_id is None


def test_two_cameras_cannot_share_a_stream_url(api, ai, db, agency, camera):
    response = api.post(f"/api/agencies/{agency.id}/cameras", json={"name": "second", "stream_url": camera.stream_url})
    assert response.status_code == 409
    assert "flux" in response.json()["detail"]


def test_a_camera_cannot_be_pointed_at_another_cameras_stream(api, ai, db, agency, camera):
    other = Camera(agency_id=agency.id, name="other", stream_url="rtsp://x/2")
    db.add(other)
    db.commit()
    assert api.put(f"/api/cameras/{other.id}", json={"stream_url": camera.stream_url}).status_code == 409
    assert api.put(f"/api/cameras/{camera.id}", json={"stream_url": camera.stream_url}).status_code == 200
